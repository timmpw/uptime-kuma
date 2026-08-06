const dayjs = require("dayjs");
const { DOWN, UP } = require("../src/util");

/**
 * Build public status-page buckets from confirmed status transitions.
 * Pending and maintenance states are available, but are not downtime.
 * @param {{status: number, time: string}|null} initialHeartbeat Last heartbeat at the range start
 * @param {Array<{status: number, time: string}>} transitions Important state transitions within the range
 * @param {dayjs.Dayjs} startTime Start of the range
 * @param {dayjs.Dayjs} endTime End of the range
 * @param {number} targetBuckets Number of buckets to return
 * @returns {{buckets: Array<{status: number|null, start: number, end: number}>, downtime: number}}
 */
function buildPublicStatusHistory(initialHeartbeat, transitions, startTime, endTime, targetBuckets) {
    const start = startTime.valueOf();
    const end = endTime.valueOf();
    const bucketDuration = (end - start) / targetBuckets;
    const buckets = Array.from({ length: targetBuckets }, (_, index) => ({
        start: Math.floor((start + index * bucketDuration) / 1000),
        end: Math.floor((start + (index + 1) * bucketDuration) / 1000),
        down: false,
        hasData: false,
    }));
    let downtime = 0;

    /**
     * Mark an interval in the matching history buckets.
     * @param {number|null} status Monitor status for the interval
     * @param {number} intervalStart Start time in milliseconds
     * @param {number} intervalEnd End time in milliseconds
     * @returns {void}
     */
    const addInterval = (status, intervalStart, intervalEnd) => {
        if (status === null || intervalEnd <= intervalStart) {
            return;
        }

        const firstBucket = Math.max(0, Math.floor((intervalStart - start) / bucketDuration));
        const lastBucket = Math.min(targetBuckets - 1, Math.ceil((intervalEnd - start) / bucketDuration) - 1);

        for (let index = firstBucket; index <= lastBucket; index++) {
            buckets[index].hasData = true;
            if (status === DOWN) {
                buckets[index].down = true;
            }
        }

        if (status === DOWN) {
            downtime += intervalEnd - intervalStart;
        }
    };

    let status = initialHeartbeat?.status ?? null;
    let intervalStart = start;

    for (const transition of transitions) {
        const transitionTime = dayjs.utc(transition.time).valueOf();
        if (transitionTime <= start || transitionTime >= end) {
            continue;
        }

        addInterval(status, intervalStart, transitionTime);
        status = transition.status;
        intervalStart = transitionTime;
    }

    addInterval(status, intervalStart, end);

    return {
        buckets: buckets.map((bucket) => ({
            status: bucket.down ? DOWN : bucket.hasData ? UP : null,
            start: bucket.start,
            end: bucket.end,
        })),
        downtime,
    };
}

module.exports = {
    buildPublicStatusHistory,
};
