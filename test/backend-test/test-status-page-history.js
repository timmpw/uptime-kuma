const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const { DOWN, MAINTENANCE, PENDING, UP } = require("../../src/util");
const { buildPublicStatusHistory } = require("../../server/status-page-history");

dayjs.extend(utc);

describe("Public status page history", () => {
    test("counts only confirmed DOWN time and colors only DOWN buckets red", () => {
        const start = dayjs.utc("2026-07-30 00:00:00");
        const end = start.add(4, "hour");
        const history = buildPublicStatusHistory(
            { status: UP, time: start.toISOString() },
            [
                { status: PENDING, time: start.add(1, "hour").toISOString() },
                { status: MAINTENANCE, time: start.add(2, "hour").toISOString() },
                { status: DOWN, time: start.add(3, "hour").toISOString() },
            ],
            start,
            end,
            4
        );

        assert.strictEqual(history.downtime, 60 * 60 * 1000);
        assert.deepStrictEqual(
            history.buckets.map((bucket) => bucket.status),
            [UP, UP, UP, DOWN]
        );
        assert.strictEqual(history.buckets[0].start, start.unix());
        assert.strictEqual(history.buckets.at(-1).end, end.unix());
    });
});
