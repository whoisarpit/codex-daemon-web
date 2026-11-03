import test from "node:test";
import assert from "node:assert/strict";
import { parseSidebarMetadata } from "../server/sidebar-metadata";

test("exposes only validated membership IDs from desktop state", () => {
  assert.deepEqual(parseSidebarMetadata({
    "projectless-thread-ids": ["none", 42, null],
    "thread-project-assignments": { assigned: { projectId: "p" }, bad: null, empty: {} },
    secret: "must not be exposed",
  }), { projectlessThreadIds: ["none"], projectThreadIds: ["assigned"] });
  for (const input of [null, [], {}, 42, { "projectless-thread-ids": {}, "thread-project-assignments": [] }]) {
    assert.deepEqual(parseSidebarMetadata(input), { projectlessThreadIds: [], projectThreadIds: [] });
  }
});
