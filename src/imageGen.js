const axios = require('axios');

// IMPORTANT: Stable Horde model IDs are human-readable names like
// "Anything Diffusion", "Deliberate", "Dreamshaper" — NOT slugs like
// "anything-v4.5". Using an invalid model name means no worker will ever
// pick up the job, and it silently times out after ~180s. This was one
// of the main reasons image generation wasn't working.
const VALID_FALLBACK_MODELS = [
    'Anything Diffusion',
    'Deliberate',
    'Dreamshaper',
    'ICBINP - I Can\'t Believe It\'s Not Photography',
    'Realistic Vision',
];

class ImageGenerator {
    constructor() {
        this.apiKey = process.env.STABLE_HORDE_KEY || '0000000000';
        this.baseUrl = 'https://stablehorde.net/api/v2';
        this.lastRequestTime = 0;
        this.minRequestInterval = 6000;
        this.activeJobs = new Map();

        if (this.apiKey === '0000000000') {
            console.warn(
                '⚠️  STABLE_HORDE_KEY not set — using the shared anonymous key. ' +
                'Anonymous requests get the LOWEST priority in the queue and can ' +
                'wait a very long time or never get picked up. Get a free key at ' +
                'https://stablehorde.net/register and set STABLE_HORDE_KEY in .env.'
            );
        }
    }

    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLast;
            console.log(`⏳ Rate limit: waiting ${(waitTime / 1000).toFixed(1)}s...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
        this.lastRequestTime = Date.now();
    }

    cleanImageData(rawData) {
        if (!rawData) {
            throw new Error('Empty image data');
        }

        let cleaned = rawData.trim();

        // Handle data URL
        if (cleaned.includes('data:image')) {
            const match = cleaned.match(/^data:image\/[a-z]+;base64,(.+)$/i);
            if (match) {
                cleaned = match[1];
            } else {
                const parts = cleaned.split(',');
                if (parts.length > 1) {
                    cleaned = parts[1];
                }
            }
        }

        // Remove whitespace and invalid chars
        cleaned = cleaned.replace(/\s/g, '');
        cleaned = cleaned.replace(/[^A-Za-z0-9+/=]/g, '');

        const base64Regex = /^[A-Za-z0-9+/=]+$/;
        if (!base64Regex.test(cleaned)) {
            throw new Error('Invalid base64 format');
        }

        if (cleaned.length < 500) {
            try {
                const decoded = Buffer.from(cleaned, 'base64').toString('utf-8');
                if (decoded.toLowerCase().includes('error') || decoded.toLowerCase().includes('failed')) {
                    throw new Error(`API Error: ${decoded.substring(0, 100)}`);
                }
            } catch (e) {
                throw new Error(`Image data too short: ${cleaned.length} chars (minimum 500)`);
            }
        }

        return cleaned;
    }

    async cancelJob(jobId) {
        try {
            await axios.delete(`${this.baseUrl}/generate/status/${jobId}`, {
                headers: { apikey: this.apiKey || '0000000000' },
            });
            console.log(`🗑️ Cancelled job ${jobId} (freeing the queue slot)`);
        } catch (err) {
            // Not critical if this fails
        }
        this.activeJobs.delete(jobId);
    }

    // Try an alternate model ONLY when the failure is model/job-specific
    // (faulted, no generations, etc). A 429 rate-limit is per API key/IP,
    // not per model, so retrying with a different model just burns time
    // and hits the same limit again — in that case we bail out immediately
    // instead of cycling through the whole fallback list.
    async generateWithFallback(prompt, options = {}) {
        const requested = options.model;
        const models = [
            ...(requested ? [requested] : []),
            ...VALID_FALLBACK_MODELS.filter(m => m !== requested),
        ];

        let lastError = null;

        for (const model of models) {
            try {
                console.log(`🔄 Trying model: ${model}`);
                const result = await this.generate(prompt, { ...options, model });
                return result;
            } catch (err) {
                lastError = err;
                console.warn(`⚠️ Model "${model}" failed:`, err.message);

                if (err.isRateLimited || err.isQueueBusy) {
                    // Global/account-level condition — switching models won't help.
                    throw err;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        throw lastError || new Error('All models failed');
    }

    async generate(prompt, options = {}) {
        const {
            width = 512,
            height = 512,
            steps = 20,
            model = 'Anything Diffusion',
            n = 1,
            cfg_scale = 7,
            // Only opt into NSFW-capable workers when the caller explicitly asks for it —
            // nsfw:true shrinks the available worker pool and can make jobs sit
            // in queue much longer (or never get picked up) unnecessarily.
            nsfw = (process.env.IMAGE_GEN_NSFW || 'false') === 'true',
            // Total wall-clock budget for this single generation attempt.
            // Kept comfortably under Telegraf's default 90s per-update
            // handler timeout so a slow queue can never crash the bot.
            maxWaitMs = parseInt(process.env.IMAGE_GEN_MAX_WAIT_MS || '75000'),
        } = options;

        const key = this.apiKey || '0000000000';
        let jobId = null;

        try {
            await this.waitForRateLimit();

            console.log(`🎨 Generating with "${model}": "${prompt.substring(0, 50)}..."`);

            const submit = await axios.post(
                `${this.baseUrl}/generate/async`,
                {
                    prompt: prompt,
                    params: {
                        n: n,
                        width: width,
                        height: height,
                        steps: steps,
                        cfg_scale: cfg_scale,
                        sampler_name: 'k_euler',
                    },
                    models: [model],
                    nsfw: nsfw,
                    trusted_workers: false,
                    slow_workers: true,
                },
                { headers: { apikey: key } },
            );

            if (submit.data.warnings?.length) {
                console.warn('⚠️ Horde warnings:', JSON.stringify(submit.data.warnings));
            }

            jobId = submit.data.id;
            if (!jobId) {
                throw new Error(`No job id returned: ${JSON.stringify(submit.data)}`);
            }
            console.log(`📤 Job ID: ${jobId}`);
            const startedAt = Date.now();
            this.activeJobs.set(jobId, startedAt);

            // Anonymous keys are limited to ~10 requests/minute TOTAL (submit +
            // every status poll counts). Polling every 2s blows straight past
            // that and triggers 429s, which used to make us abandon the whole
            // model. Start well above the anonymous safe rate and back off
            // further (not abort) on an actual 429.
            let pollInterval = 6500;
            let lastKnownStatus = null;

            while (Date.now() - startedAt < maxWaitMs) {
                await new Promise(r => setTimeout(r, pollInterval));

                let status;
                try {
                    status = await axios.get(`${this.baseUrl}/generate/status/${jobId}`, {
                        headers: { apikey: key },
                    });
                } catch (pollErr) {
                    if (pollErr.response?.status === 429) {
                        // Rate-limited on the STATUS CHECK itself — back off hard
                        // and keep waiting on the same job, don't give up on it.
                        const retryAfter = parseInt(pollErr.response.headers?.['retry-after'] || '20', 10);
                        console.warn(`⚠️ Rate limited while polling, backing off ${retryAfter}s...`);
                        pollInterval = Math.max(pollInterval, (retryAfter + 2) * 1000);
                        continue;
                    }
                    throw pollErr;
                }

                const data = status.data;
                lastKnownStatus = data;

                if (data.done && data.generations && data.generations.length > 0) {
                    this.activeJobs.delete(jobId);

                    let rawImage = data.generations[0].img;
                    if (!rawImage || rawImage.length < 100) {
                        throw new Error('Received empty or invalid image data');
                    }

                    console.log(`✅ Image generated in ${((Date.now() - startedAt) / 1000).toFixed(1)}s!`);

                    try {
                        const decoded = Buffer.from(rawImage, 'base64').toString('utf-8');
                        if (decoded.toLowerCase().includes('error')) {
                            throw new Error(`API returned error: ${decoded.substring(0, 200)}`);
                        }
                    } catch (e) {
                        // not a text error, fine
                    }

                    return this.cleanImageData(rawImage);
                }

                if (data.done && (!data.generations || data.generations.length === 0)) {
                    this.activeJobs.delete(jobId);
                    throw new Error('Generation completed but no image returned');
                }

                if (data.faulted) {
                    this.activeJobs.delete(jobId);
                    throw new Error('Generation faulted (worker rejected the job)');
                }

                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
                const queuePos = data.queue_position !== undefined ? data.queue_position : '?';
                const waitTime = data.wait_time !== undefined ? `${data.wait_time}s` : '?';
                console.log(`⏳ ${elapsed}s elapsed - Queue position: ${queuePos}, est wait: ${waitTime}`);
            }

            // Budget exceeded — cancel the job so it stops occupying a queue slot,
            // and surface the real queue info so the caller can give an honest
            // "the public queue is just very busy right now" message.
            const err = new Error(
                `Queue is very busy (position ${lastKnownStatus?.queue_position ?? '?'}, ` +
                `est. wait ${lastKnownStatus?.wait_time ?? '?'}s) — gave up after ${(maxWaitMs / 1000).toFixed(0)}s`,
            );
            err.isQueueBusy = true;
            throw err;
        } catch (err) {
            if (jobId) await this.cancelJob(jobId);

            if (err.isQueueBusy) throw err;

            if (err.response?.status === 429) {
                const rateLimitErr = new Error(
                    'Rate limited by Stable Horde (anonymous keys get ~10 requests/min). ' +
                    'Get a free key at https://stablehorde.net/register for much higher limits.',
                );
                rateLimitErr.isRateLimited = true;
                console.error('❌ Stable Horde error: rate limited (429)');
                throw rateLimitErr;
            }

            const apiMsg = err.response?.data?.message || err.response?.data;
            console.error('❌ Stable Horde error:', apiMsg || err.message);
            throw new Error(apiMsg ? `${err.message} — ${JSON.stringify(apiMsg)}` : err.message);
        }
    }

    async checkStatus() {
        try {
            const response = await axios.get(`${this.baseUrl}/status`);
            return response.data;
        } catch (err) {
            return null;
        }
    }
}

module.exports = { ImageGenerator };