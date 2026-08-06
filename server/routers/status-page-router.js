let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants, UP, DOWN, MAINTENANCE, PENDING } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");
const { buildPublicStatusHistory } = require("../status-page-history");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");

dayjs.extend(utc);

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

/**
 * Load the status transitions needed to render a public status history.
 * Important heartbeats retain each DOWN/UP/maintenance transition after old samples are cleaned up.
 * @param {number} monitorID Monitor ID
 * @param {number} days Number of days to include
 * @param {number} targetBuckets Number of history buckets
 * @returns {Promise<{buckets: Array<{status: number|null, end: number}>, downtime: number}>}
 */
async function getPublicStatusHistory(monitorID, days, targetBuckets) {
    const endTime = dayjs.utc();
    const startTime = endTime.subtract(days, "day");
    const startDate = R.isoDateTimeMillis(startTime);
    const endDate = R.isoDateTimeMillis(endTime);
    const initialHeartbeat = await R.getRow(
        "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND time <= ? ORDER BY time DESC LIMIT 1",
        [monitorID, startDate]
    );
    const transitions = await R.getAll(
        "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time > ? AND time <= ? ORDER BY time",
        [monitorID, startDate, endDate]
    );

    return buildPublicStatusHistory(initialHeartbeat, transitions, startTime, endTime, targetBuckets);
}

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};
        let downtimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);
        let statusPage = await R.findOne("status_page", " id = ? ", [statusPageID]);
        let heartbeatBarDays = Math.max(0, Math.min(365, statusPage?.heartbeat_bar_days || 0));
        let maxBeats = Math.max(1, Math.min(parseInt(request.query.maxBeats, 10) || 100, 100));

        let monitorList = await R.getAll(
            `
            SELECT DISTINCT monitor_group.monitor_id, monitor.interval
            FROM monitor_group
            JOIN \`group\` ON monitor_group.group_id = \`group\`.id
            JOIN monitor ON monitor.id = monitor_group.monitor_id
            WHERE \`group\`.public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        for (let monitor of monitorList) {
            const monitorID = monitor.monitor_id;
            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            const statusHistory = await getPublicStatusHistory(monitorID, Math.max(heartbeatBarDays, 1), maxBeats);

            if (heartbeatBarDays === 0) {
                let list = await R.getAll(
                    `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 100
                `,
                    [monitorID]
                );

                list = R.convertToBeans("heartbeat", list);
                heartbeatList[monitorID] = list.reverse().map((row) => ({
                    ...row.toPublicJSON(),
                    // Planned maintenance is not an incident on a public status page.
                    status: row.status === MAINTENANCE ? UP : row.status,
                }));
            } else {
                heartbeatList[monitorID] = statusHistory.buckets.map((bucket) => {
                        if (bucket.status === null) {
                            return 0;
                        }

                        return {
                            status: bucket.status,
                            time: dayjs.unix(bucket.end).toISOString(),
                            periodStart: dayjs.unix(bucket.start).toISOString(),
                            msg: "",
                            ping: null,
                        };
                    });
            }

            const uptimeType = heartbeatBarDays <= 1 ? "24" : `${heartbeatBarDays}d`;
            const uptimeData =
                heartbeatBarDays <= 1
                    ? uptimeCalculator.get24Hour()
                    : uptimeCalculator.getData(heartbeatBarDays, "day");
            uptimeList[`${monitorID}_${uptimeType}`] = uptimeData.uptime;
            downtimeList[`${monitorID}_${uptimeType}`] = statusHistory.downtime;
        }

        response.json({
            heartbeatList,
            uptimeList,
            downtimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
