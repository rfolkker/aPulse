// This app will create a json downloadable file with the status retrieved from the elastic database on request and display in the UI.
import express from 'express';
import { Client } from '@elastic/elasticsearch';
import config from './config/config.js';

const app = express();
const port = 3000;

const client = new Client({
    node: config.elastic.url,
    auth: {
        apiKey: config.elastic.apiKey,
    },
});

const getSearchBody = (result) => result?.body || result;
const handlize = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, '-');

const toMillis = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return Date.now();
};

const buildConfiguredSites = () => {
    const siteMap = {};
    const siteOrder = [];
    const allConfiguredSiteIds = [];
    const selectedSiteSet = new Set((config.displaySites || []).map((s) => String(s)));
    let siteIndex = 0;

    for (const site of (config.sites || [])) {
        siteIndex += 1;
        let siteId = site.id || handlize(site.name) || `site-${siteIndex}`;
        const baseSiteId = siteId;
        let i = 1;
        while (allConfiguredSiteIds.includes(siteId)) {
            siteId = `${baseSiteId}-${++i}`;
        }
        allConfiguredSiteIds.push(siteId);

        const shouldDisplay = selectedSiteSet.size === 0 || selectedSiteSet.has(siteId);
        if (!shouldDisplay) {
            continue;
        }

        const endpoints = {};
        const endpointIds = [];
        let endpointIndex = 0;
        for (const endpoint of (site.endpoints || [])) {
            endpointIndex += 1;
            let endpointId = endpoint.id || handlize(endpoint.name) || `endpoint-${endpointIndex}`;
            const baseEndpointId = endpointId;
            let j = 1;
            while (endpointIds.includes(endpointId)) {
                endpointId = `${baseEndpointId}-${++j}`;
            }
            endpointIds.push(endpointId);

            endpoints[endpointId] = {
                name: endpoint.name || endpointId,
                link: endpoint.link === false ? undefined : (endpoint.link || endpoint.url),
                responseTimeGood: endpoint.responseTimeGood || config.responseTimeGood,
                responseTimeWarning: endpoint.responseTimeWarning || config.responseTimeWarning,
                logs: [],
            };
        }

        siteMap[siteId] = {
            name: site.name || siteId,
            endpoints,
        };
        siteOrder.push([siteId, endpointIds]);
    }

    return { siteMap, siteOrder, selectedSiteSet };
};

// End points are:

//   GET /instances -> returns the list of instances that have sent data to Elastic, so we can display them in a dropdown in the UI to filter by instance
app.get('/instances', async (req, res) => {
    try {
        const query = {
            index: config.elastic.index,
            size: 0,
            aggs: {
                instances: {
                    terms: {
                        field: 'instance_id.keyword',
                        size: 100, // Adjust as needed
                    },
                },
            },
        };

        const body = getSearchBody(await client.search(query));
        const instances = body.aggregations.instances.buckets.map(bucket => bucket.key);
        res.json(instances);
    } catch (error) {
        console.error('Error fetching instances:', error);
        res.status(500).json({ error: 'Error fetching instances' });
    }
});

//   GET /status?instanceId=instance-1 -> returns the status of the endpoints for the given instanceId (or all if not provided) in a json format
app.get('/status', async (req, res) => {
    try {
        const instanceId = req.query.instanceId || config.instanceId || 'default-instance';
        const { siteMap, siteOrder, selectedSiteSet } = buildConfiguredSites();
        const query = {
            index: config.elastic.index,
            size: 5000,
            sort: [{ event_time: { order: 'desc' } }],
            query: {
                bool: {
                    must: [
                        ...(instanceId ? [{ term: { 'instance_id.keyword': instanceId } }] : []),
                        ...(selectedSiteSet.size > 0 ? [{ terms: { 'site_id.keyword': [...selectedSiteSet] } }] : []),
                    ],
                },
            },
        };

        const body = getSearchBody(await client.search(query));
        const hits = body.hits.hits;

        const status = {
            config: {
                interval: config.interval,
                nDataPoints: config.nDataPoints,
                responseTimeGood: config.responseTimeGood,
                responseTimeWarning: config.responseTimeWarning,
            },
            lastPulse: 0,
            ui: [...siteOrder],
            sites: { ...siteMap },
        };

        const endpointOrder = new Map(siteOrder.map(([siteId, endpointIds]) => [siteId, [...endpointIds]]));

        for (const hit of hits) {
            const source = hit._source || {};
            const siteId = source.site_id || source.siteId;
            const endpointId = source.endpoint_id || source.endpointId;
            if (!siteId || !endpointId) {
                continue;
            }

            const eventTime = toMillis(source.event_time);
            if (eventTime > status.lastPulse) {
                status.lastPulse = eventTime;
            }

            if (!status.sites[siteId]) {
                status.sites[siteId] = {
                    name: source.site_name || source.siteName || siteId,
                    endpoints: {},
                };
                status.ui.push([siteId, []]);
                endpointOrder.set(siteId, []);
            }

            if (!status.sites[siteId].endpoints[endpointId]) {
                status.sites[siteId].endpoints[endpointId] = {
                    name: source.endpoint_name || source.endpointName || endpointId,
                    link: source.link,
                    responseTimeGood: source.good_threshold || source.goodThreshold,
                    responseTimeWarning: source.warning_threshold || source.warningThreshold,
                    logs: [],
                };
                endpointOrder.get(siteId).push(endpointId);
                const statusUiSite = status.ui.find(([id]) => id === siteId);
                if (statusUiSite) {
                    statusUiSite[1].push(endpointId);
                }
            }

            const performance = source.performance || {};
            status.sites[siteId].endpoints[endpointId].logs.push({
                t: toMillis(performance.t ?? source.event_time),
                err: performance.err,
                ttfb: performance.ttfb,
                dur: performance.dur,
                dns: performance.dns,
                tcp: performance.tcp,
            });
        }

        for (const [siteId, endpointIds] of status.ui) {
            for (const endpointId of endpointOrder.get(siteId)) {
                const endpoint = status.sites[siteId].endpoints[endpointId];
                endpoint.logs.sort((a, b) => a.t - b.t);
                if (endpoint.logs.length > status.config.nDataPoints) {
                    endpoint.logs = endpoint.logs.slice(-status.config.nDataPoints);
                }
            }
        }

        res.json(status);
    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({ error: 'Error fetching status' });
    }
});

// the root path will serve the index.html file from the static folder
app.use(express.static('static'));

app.listen(port, () => {
    console.log(`aPulse status app listening at http://localhost:${port}`);
});