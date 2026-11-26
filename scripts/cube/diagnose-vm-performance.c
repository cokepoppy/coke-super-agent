#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <linux/futex.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Build one static ARM64 binary and run the identical bytes on the Lima host
 * and in a disposable Cube VM. This is a diagnostic, not a Chrome benchmark. */
static volatile uint64_t checksum;
static struct timespec started;
static struct rusage before;

static double milliseconds(struct timespec a, struct timespec b) {
  return (double)(b.tv_sec - a.tv_sec) * 1000.0 + (double)(b.tv_nsec - a.tv_nsec) / 1000000.0;
}
static double timeval_ms(struct timeval value) {
  return (double)value.tv_sec * 1000.0 + (double)value.tv_usec / 1000.0;
}
static void begin(const char *name) {
  printf("{\"stage\":\"%s.start\"}\n", name); fflush(stdout);
  if (getrusage(RUSAGE_SELF, &before) || clock_gettime(CLOCK_MONOTONIC, &started)) exit(2);
}
static void end(const char *name) {
  struct timespec now;
  struct rusage after;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || getrusage(RUSAGE_SELF, &after)) exit(2);
  double cpu = timeval_ms(after.ru_utime) + timeval_ms(after.ru_stime)
    - timeval_ms(before.ru_utime) - timeval_ms(before.ru_stime);
  printf("{\"stage\":\"%s.complete\",\"wallMs\":%.3f,\"cpuMs\":%.3f,\"minorFaults\":%ld,\"majorFaults\":%ld,\"voluntarySwitches\":%ld,\"involuntarySwitches\":%ld}\n",
    name, milliseconds(started, now), cpu, after.ru_minflt - before.ru_minflt,
    after.ru_majflt - before.ru_majflt, after.ru_nvcsw - before.ru_nvcsw,
    after.ru_nivcsw - before.ru_nivcsw);
  fflush(stdout);
}
static void fail(const char *stage) { perror(stage); exit(2); }
static long anon_huge_kb(void *address) {
  FILE *file = fopen("/proc/self/smaps", "r");
  if (!file) return -1;
  char line[512];
  unsigned long from, to;
  int in_mapping = 0;
  long result = -1;
  while (fgets(line, sizeof(line), file)) {
    if (sscanf(line, "%lx-%lx", &from, &to) == 2) {
      in_mapping = (uintptr_t)address >= from && (uintptr_t)address < to;
    } else if (in_mapping && sscanf(line, "AnonHugePages: %ld kB", &result) == 1) {
      break;
    }
  }
  fclose(file);
  return result;
}

int main(void) {
  struct utsname host;
  if (uname(&host)) fail("uname");
  const long page = sysconf(_SC_PAGESIZE);
  if (page <= 0) fail("pagesize");
  printf("{\"stage\":\"environment\",\"machine\":\"%s\",\"kernel\":\"%s\",\"pageSize\":%ld,\"onlineCpus\":%ld}\n", host.machine, host.release, page, sysconf(_SC_NPROCESSORS_ONLN)); fflush(stdout);

  begin("integer");
  uint64_t value = UINT64_C(0x123456789abcdef0);
  for (int i = 0; i < 20000000; ++i) { value ^= value << 13; value ^= value >> 7; value ^= value << 17; }
  checksum = value;
  end("integer");

  begin("getpid_syscall");
  for (int i = 0; i < 100000; ++i) value += (uint64_t)syscall(SYS_getpid);
  checksum = value;
  end("getpid_syscall");

  const size_t size = 32U * 1024U * 1024U;
  begin("anonymous_page_faults");
  volatile unsigned char *memory = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (memory == MAP_FAILED) fail("mmap");
  for (size_t offset = 0; offset < size; offset += (size_t)page) memory[offset] = 1;
  end("anonymous_page_faults");

  begin("protection_churn");
  for (int round = 0; round < 4; ++round) {
    if (mprotect((void *)memory, size, PROT_READ) || mprotect((void *)memory, size, PROT_READ | PROT_WRITE)) fail("mprotect");
    for (size_t offset = 0; offset < size; offset += (size_t)page) memory[offset]++;
  }
  end("protection_churn");
  if (munmap((void *)memory, size)) fail("munmap");

  /* Keep this mitigation local to the benchmark process; never change the
   * host or guest global transparent-hugepage configuration. */
  const size_t huge = 2U * 1024U * 1024U;
  begin("hugepage_madvise");
  unsigned char *raw = mmap(NULL, size + huge, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (raw == MAP_FAILED) fail("mmap_huge");
  uintptr_t aligned = ((uintptr_t)raw + huge - 1) & ~(uintptr_t)(huge - 1);
  size_t prefix = aligned - (uintptr_t)raw;
  size_t suffix = size + huge - prefix - size;
  if ((prefix && munmap(raw, prefix)) || (suffix && munmap((void *)(aligned + size), suffix))) fail("munmap_alignment");
  memory = (volatile unsigned char *)aligned;
  if (madvise((void *)memory, size, MADV_HUGEPAGE)) fail("madvise_huge");
  for (size_t offset = 0; offset < size; offset += (size_t)page) memory[offset] = 1;
  end("hugepage_madvise");
  printf("{\"stage\":\"hugepage_madvise.mapping\",\"anonHugeKb\":%ld}\n", anon_huge_kb((void *)memory)); fflush(stdout);
  if (munmap((void *)memory, size)) fail("munmap_huge");

  int futex_word = 0;
  begin("futex_wake");
  for (int i = 0; i < 100000; ++i) if (syscall(SYS_futex, &futex_word, FUTEX_WAKE_PRIVATE, 1, NULL, NULL, 0) < 0) fail("futex");
  end("futex_wake");

  begin("fork_wait");
  for (int i = 0; i < 10; ++i) {
    pid_t child = fork();
    if (child < 0) fail("fork");
    if (child == 0) _exit(0);
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) fail("waitpid");
  }
  end("fork_wait");
  printf("{\"stage\":\"complete\",\"checksum\":\"%" PRIu64 "\"}\n", checksum); fflush(stdout);
  return 0;
}
