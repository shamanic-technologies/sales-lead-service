/**
 * One log line per thread every 10 min with its V8 heap and the process RSS (BOX-OVERLOAD-1026): the container held
 * 1.15 GB resident + 0.5 GB swapped after ~25 h, and nothing said which of the four threads held it. Read from the logs
 * (`docker logs distribute-lead-service-1 | grep '\[memory\]'`) to compare uptime against heap.
 */
import { getHeapStatistics } from "node:v8";

export const MEMORY_REPORT_INTERVAL_MS = 10 * 60_000;

const mb = (n: number) => Math.round(n / 1_048_576);

/** PURE: the report line. */
export function memoryLine(thread: string, uptimeS: number, heapUsed: number, heapTotal: number, rss: number, external: number): string {
  return `[memory] thread=${thread} uptimeMin=${Math.round(uptimeS / 60)} heapUsedMb=${mb(heapUsed)} heapTotalMb=${mb(heapTotal)} rssMb=${mb(rss)} externalMb=${mb(external)}`;
}

export function startMemoryReport(thread: string): void {
  const started = Date.now();
  setInterval(() => {
    const heap = getHeapStatistics();
    const usage = process.memoryUsage();
    console.log(memoryLine(thread, (Date.now() - started) / 1000, heap.used_heap_size, heap.total_heap_size, usage.rss, heap.external_memory));
  }, MEMORY_REPORT_INTERVAL_MS).unref();
}
