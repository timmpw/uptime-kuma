<template>
    <span :class="className" :title="title">{{ showDowntime ? downtime : uptime }}</span>
</template>

<script>
import { DOWN, MAINTENANCE, PENDING, UP } from "../util.ts";

export default {
    props: {
        /** Monitor this represents */
        monitor: {
            type: Object,
            default: null,
        },
        /** Type of monitor */
        type: {
            type: String,
            default: null,
        },
        /** Is this a pill? */
        pill: {
            type: Boolean,
            default: false,
        },
        /** Show total downtime for the selected period */
        showDowntime: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        uptime() {
            if (this.type === "maintenance") {
                return this.$t("statusMaintenance");
            }

            let key = this.monitor.id + "_" + this.type;

            if (this.$root.uptimeList[key] !== undefined) {
                let result = Math.round(this.$root.uptimeList[key] * 10000) / 100;
                // Only perform sanity check on status page. See louislam/uptime-kuma#2628
                if (this.$route.path.startsWith("/status") && result > 100) {
                    return "100%";
                } else {
                    return result + "%";
                }
            }

            return this.$t("notAvailableShort");
        },

        downtime() {
            const key = this.monitor.id + "_" + this.type;
            const milliseconds = this.$root.downtimeList[key];

            if (milliseconds === undefined) {
                return this.$t("notAvailableShort");
            }

            const totalMinutes = Math.round(milliseconds / 60000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;

            return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        },
        color() {
            if (this.lastHeartBeat.status === MAINTENANCE) {
                return this.$route.path.startsWith("/status") ? "primary" : "maintenance";
            }

            if (this.lastHeartBeat.status === DOWN) {
                return "danger";
            }

            if (this.lastHeartBeat.status === UP) {
                return "primary";
            }

            if (this.lastHeartBeat.status === PENDING) {
                return "warning";
            }

            return "secondary";
        },
        lastHeartBeat() {
            if (this.monitor.id in this.$root.lastHeartbeatList && this.$root.lastHeartbeatList[this.monitor.id]) {
                return this.$root.lastHeartbeatList[this.monitor.id];
            }

            return {
                status: -1,
            };
        },

        className() {
            if (this.pill) {
                return `badge rounded-pill bg-${this.color}`;
            }

            return "";
        },

        title() {
            if (this.type === "1y") {
                return this.$t("years", 1);
            }
            if (this.type === "720") {
                return this.$t("days", 30);
            }
            const dayMatch = this.type.match(/^(\d+)d$/);
            if (dayMatch) {
                return this.$t("days", parseInt(dayMatch[1]));
            }
            return this.$t("hours", 24);
        },

    },
};
</script>

<style>
.badge {
    min-width: 62px;
}

</style>
