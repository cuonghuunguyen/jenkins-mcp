/**
 * Queue listing tests (READ-12).
 *
 * The client is faked, never global fetch: the client's own contract is tested
 * in client.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { JenkinsCache } from "../cache.js";
import { formatQueueListing } from "../format/queue.js";
import { listQueue } from "../operations/queue-list.js";
import { createMockClient } from "./fixtures.js";

const NOW = Date.now();

afterEach(() => {
  vi.useRealTimers();
});

/** Three items covering every derived state, including one that is both stuck and buildable. */
const QUEUE = {
  items: [
    {
      id: 11,
      why: "Waiting for next available executor",
      blocked: false,
      buildable: true,
      stuck: true,
      inQueueSince: NOW - 42 * 60_000,
      task: { name: "main", fullName: "team-a/svc/main" },
      actions: [
        {
          parameters: [
            { name: "BRANCH", value: "main" },
            { name: "DRY_RUN", value: true },
          ],
        },
      ],
    },
    {
      id: 12,
      why: "Build #12 is already in progress",
      blocked: true,
      buildable: false,
      stuck: false,
      inQueueSince: NOW - 3 * 60_000,
      task: { name: "PR-7", fullName: "team-b/api/PR-7" },
    },
    {
      id: 13,
      why: null,
      blocked: false,
      buildable: true,
      stuck: false,
      inQueueSince: NOW - 5_000,
      task: { name: "nightly", fullName: "team-c/nightly" },
    },
  ],
};

function setup(fixtureBody: unknown, status?: number) {
  const mock = createMockClient([{ match: "/queue/api/json", body: fixtureBody, status }]);
  return { ...mock, cache: new JenkinsCache() };
}

describe("listQueue", () => {
  it("normalizes every item and derives its state", async () => {
    const { client, cache } = setup(QUEUE);

    const data = await listQueue(client, cache);

    expect(data.total).toBe(3);
    expect(data.items.map((item) => item.state)).toEqual(["stuck", "blocked", "buildable"]);
    expect(data.items[0]?.jobFullName).toBe("team-a/svc/main");
    expect(data.items[0]?.params).toEqual([
      { name: "BRANCH", value: "main" },
      { name: "DRY_RUN", value: "true" },
    ]);
    expect(data.items[0]?.waitingFor).toBeGreaterThanOrEqual(42 * 60_000);
    expect(data.items[2]?.why).toBeNull();
  });

  it("prefers stuck over buildable, because stuck is the state an operator must act on", async () => {
    const { client, cache } = setup(QUEUE);

    const data = await listQueue(client, cache);

    expect(data.items[0]?.state).toBe("stuck");
  });

  it("requests exactly one projected queue call", async () => {
    const { client, cache, get } = setup(QUEUE);

    await listQueue(client, cache);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toContain("tree=items[id,why,blocked,buildable,stuck");
  });

  it("serves the second call from the volatile tier without a second request", async () => {
    const { client, cache, get } = setup(QUEUE);

    await listQueue(client, cache);
    await listQueue(client, cache);

    expect(get).toHaveBeenCalledTimes(1);
    expect(cache.loadCount()).toBe(1);
  });

  it("expires that entry after the 10s volatile TTL, not a longer one", async () => {
    // A cache-hit assertion alone passes identically for `permanent` or
    // `index`; the queue is the one state the 10s tier is explicit about.
    vi.useFakeTimers();
    const { client, cache, get } = setup(QUEUE);

    await listQueue(client, cache);
    vi.advanceTimersByTime(10_001);
    await listQueue(client, cache);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("returns an empty listing for an empty queue", async () => {
    const { client, cache } = setup({});

    const data = await listQueue(client, cache);

    expect(data).toEqual({ items: [], total: 0 });
  });

  it("keeps an item whose task carries no name, rather than throwing", async () => {
    const { client, cache } = setup({ items: [{ id: 9, why: "In the quiet period", task: {} }] });

    const data = await listQueue(client, cache);

    expect(data.items[0]?.jobFullName).toBeUndefined();
    expect(data.items[0]?.state).toBe("waiting");
    expect(data.items[0]?.waitingFor).toBeUndefined();
  });

  it("falls back to task.name when fullName is absent", async () => {
    const { client, cache } = setup({ items: [{ id: 9, task: { name: "standalone" } }] });

    const data = await listQueue(client, cache);

    expect(data.items[0]?.jobFullName).toBe("standalone");
  });

  it("normalizes a 403 to a forbidden JenkinsError", async () => {
    const { client, cache } = setup({}, 403);

    await expect(listQueue(client, cache)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("formatQueueListing", () => {
  it("renders a four-column table with counts", async () => {
    const { client, cache } = setup(QUEUE);

    const text = formatQueueListing(await listQueue(client, cache));

    expect(text).toContain("queue (3)");
    expect(text).toContain("job");
    expect(text).toContain("team-a/svc/main");
    expect(text).toContain("stuck");
    // Tolerant on the seconds: `waitingFor` is measured against the real clock
    // inside the operation, so wall time between this module loading and the
    // call drifts the value by a second under load. The assertion is that the
    // wait is rendered as a duration, not that the clock stood still.
    expect(text).toMatch(/42m\d\ds/);
    expect(text).toContain("next: {build}");
  });

  it("states the shown-of-total counts when the row cap truncates", async () => {
    const { client, cache } = setup({
      items: Array.from({ length: 25 }, (_, index) => ({
        id: index,
        task: { fullName: `job-${index}` },
        buildable: true,
        inQueueSince: NOW - 1000,
      })),
    });

    const text = formatQueueListing(await listQueue(client, cache));

    expect(text).toContain("queue (showing 20 of 25)");
    expect(text).not.toContain("job-20 ");
  });

  it("keeps the stuck item visible when the listing truncates", async () => {
    // Truncation preserved Jenkins' order, so the one `stuck` row the tool
    // exists to surface could be dropped - and no call returns rows 21-25.
    const items = [
      ...Array.from({ length: 24 }, (_, i) => ({
        id: i,
        task: { fullName: `job-${i}` },
        why: "Waiting",
        buildable: true,
      })),
      { id: 99, task: { fullName: "the-stuck-one" }, why: "Stuck", stuck: true },
    ];
    const { client, cache } = setup({ items });

    const text = formatQueueListing(await listQueue(client, cache));

    expect(text).toContain("queue (showing 20 of 25)");
    expect(text).toContain("the-stuck-one");
    expect(text).toContain("[5 lower-priority item(s) omitted");
  });

  it("prints the explicit empty line, so no queue never reads as a failed call", async () => {
    const { client, cache } = setup({ items: [] });

    const text = formatQueueListing(await listQueue(client, cache));

    expect(text).toContain("No queued items found");
    expect(text).toContain("next: {findJobs}");
  });

  it("keeps a multi-line why on one row", async () => {
    const { client, cache } = setup({
      items: [{ id: 1, task: { fullName: "svc" }, why: "blocked\nby upstream", blocked: true }],
    });

    const text = formatQueueListing(await listQueue(client, cache));

    expect(text).toContain("blocked");
    expect(text).not.toContain("by upstream");
  });
});
