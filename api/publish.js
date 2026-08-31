import { put } from '@vercel/blob';
import { buildStandaloneHtml } from '../lib/template.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

async function telegram(method, body) {
    const result = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    return result.json();
}

async function downloadTelegramFileAsBase64(fileId) {
    const file = await telegram('getFile', { file_id: fileId });
    if (!file.ok || !file.result?.file_path) {
        throw new Error(`Telegram file lookup failed: ${file.description || 'Unknown error'}`);
    }
    const download = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
    if (!download.ok) throw new Error(`Telegram file download failed: ${download.statusText}`);

    const arrayBuffer = await download.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filePathLower = (file.result.file_path || '').toLowerCase();
    let mime = 'image/jpeg';
    if (filePathLower.endsWith('.png')) mime = 'image/png';
    else if (filePathLower.endsWith('.webp')) mime = 'image/webp';
    else if (filePathLower.endsWith('.svg')) mime = 'image/svg+xml';
    else if (filePathLower.endsWith('.gif')) mime = 'image/gif';
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function saveTelegramFile(fileId, path) {
    const file = await telegram('getFile', { file_id: fileId });
    if (!file.ok || !file.result?.file_path) {
        throw new Error(`Telegram file lookup failed: ${file.description || 'Unknown error'}`);
    }
    const download = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
    if (!download.ok) throw new Error(`Telegram file download failed: ${download.statusText}`);

    const options = { access: 'private', addRandomSuffix: false, allowOverwrite: true };
    if (blobToken) options.token = blobToken;
    return put(path, await download.arrayBuffer(), options);
}

function generateProjectSlug(value) {
    const clean = (value || 'app')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 25) || 'app';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rand = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${clean}-${rand}`;
}

const vercelToken = process.env.VERCEL_TOKEN;
let cachedTeamId = process.env.VERCEL_TEAM_ID || null;

async function getTeamId() {
    if (cachedTeamId) return cachedTeamId;
    if (!vercelToken) return null;
    try {
        const res = await fetch('https://api.vercel.com/v9/projects', {
            headers: { Authorization: `Bearer ${vercelToken}` },
        });
        if (res.ok) {
            const data = await res.json();
            const first = data.projects?.[0];
            cachedTeamId = first?.accountId || first?.teamId || null;
            if (cachedTeamId) return cachedTeamId;
        }
        const userRes = await fetch('https://api.vercel.com/v2/user', {
            headers: { Authorization: `Bearer ${vercelToken}` },
        });
        if (userRes.ok) {
            const userData = await userRes.json();
            cachedTeamId = userData.user?.defaultTeamId || null;
            return cachedTeamId;
        }
    } catch (e) {
        console.error('Could not fetch user team ID:', e);
    }
    return null;
}

async function createVercelProject(name) {
    const teamId = await getTeamId();
    const endpoint = teamId
        ? `https://api.vercel.com/v9/projects?teamId=${encodeURIComponent(teamId)}`
        : 'https://api.vercel.com/v9/projects';
    const result = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (result.ok || result.status === 409) return name;
    if (result.status === 401 || result.status === 403) {
        throw new Error('Vercel token is invalid or missing team permissions');
    }
    throw new Error(`Vercel project creation failed: ${result.status}`);
}

async function deployProject(name, html) {
    const teamId = await getTeamId();
    const endpoint = teamId
        ? `https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(teamId)}`
        : 'https://api.vercel.com/v13/deployments';
    const result = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            name,
            project: name,
            files: [{ file: 'index.html', data: html }],
            projectSettings: { framework: null }
        })
    });
    if (!result.ok) throw new Error(`Vercel deployment failed with status ${result.status}`);
    return result.json();
}

async function registerVercelDomainAndAlias(slug, htmlContent = null) {
    if (!vercelToken) return false;
    const teamId = await getTeamId();
    const targetProject = 'playstore-web-143';
    const domainName = `${slug}.vercel.app`;

    // 1. If HTML is provided, try standalone deployment first
    if (htmlContent) {
        try {
            await createVercelProject(slug);
            await deployProject(slug, htmlContent);
            return true;
        } catch (deployErr) {
            console.warn('Standalone deploy skipped/restricted:', deployErr.message);
        }
    }

    // 2. Fetch project to get the production deployment ID
    let depId = null;
    try {
        const projEndpoint = teamId
            ? `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}?teamId=${encodeURIComponent(teamId)}`
            : `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}`;
        const projRes = await fetch(projEndpoint, { headers: { Authorization: `Bearer ${vercelToken}` } });
        if (projRes.ok) {
            const projData = await projRes.json();
            depId = projData.targets?.production?.id;
        }
    } catch (e) {
        console.warn('Could not fetch production deployment ID:', e.message);
    }

    // 3. Add domain to project (with auto-prune of oldest domains if 50 limit is reached)
    const domainEndpoint = teamId
        ? `https://api.vercel.com/v10/projects/${encodeURIComponent(targetProject)}/domains?teamId=${encodeURIComponent(teamId)}`
        : `https://api.vercel.com/v10/projects/${encodeURIComponent(targetProject)}/domains`;

    let addRes = await fetch(domainEndpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: domainName }),
    });

    if (!addRes.ok && addRes.status !== 409) {
        const errData = await addRes.json().catch(() => ({}));
        if (addRes.status === 400 && (errData.error?.code === 'project_domain_limit_reached' || errData.error?.message?.includes('maximum allowed number of domains'))) {
            console.warn('Domain limit reached on project, auto-pruning oldest dynamic domains...');
            try {
                const listEndpoint = teamId
                    ? `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}/domains?teamId=${encodeURIComponent(teamId)}&limit=100`
                    : `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}/domains?limit=100`;
                const listRes = await fetch(listEndpoint, { headers: { Authorization: `Bearer ${vercelToken}` } });
                if (listRes.ok) {
                    const listData = await listRes.json();
                    const domains = listData.domains || [];
                    const sorted = [...domains].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
                    const prunable = sorted.filter((d) => {
                        const n = (d.name || '').toLowerCase();
                        return !n.startsWith('playstore-web-143') && !n.includes('main') && !n.includes('production');
                    });
                    for (const d of prunable.slice(0, 5)) {
                        const delEndpoint = teamId
                            ? `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}/domains/${encodeURIComponent(d.name)}?teamId=${encodeURIComponent(teamId)}`
                            : `https://api.vercel.com/v9/projects/${encodeURIComponent(targetProject)}/domains/${encodeURIComponent(d.name)}`;
                        await fetch(delEndpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${vercelToken}` } });
                    }
                    await fetch(domainEndpoint, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
                        body: JSON.stringify({ name: domainName }),
                    });
                }
            } catch (pruneErr) {
                console.error('Error auto-pruning domains:', pruneErr);
            }
        }
    }

    // 4. Bind alias directly to the active production deployment for INSTANT 200 OK routing!
    if (depId) {
        try {
            const aliasEndpoint = teamId
				? `https://api.vercel.com/v2/deployments/${depId}/aliases?teamId=${encodeURIComponent(teamId)}`
				: `https://api.vercel.com/v2/deployments/${depId}/aliases`;
            await fetch(aliasEndpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
                body: JSON.stringify({ alias: domainName }),
            });
        } catch (aliasErr) {
            console.error('Error assigning alias to production deployment:', aliasErr);
        }
    }

    return true;
}

export default async function handler(request, response) {
    if (request.method !== 'POST') return response.status(405).json({ error: 'POST only' });
    if (!process.env.PUBLISH_SECRET || request.headers['x-publish-secret'] !== process.env.PUBLISH_SECRET) {
        return response.status(401).json({ error: 'Unauthorized: Invalid PUBLISH_SECRET' });
    }
    const body = request.body || {};
    if (!token || !body.name || !body.logoFileId || !body.apkFileId) {
        return response.status(400).json({ error: 'Missing required app details or TELEGRAM_BOT_TOKEN' });
    }

    try {
        const projectName = generateProjectSlug(body.name);
        
        // Resolve logo: Prioritize base64 data URL for 100% instant and reliable rendering!
        let logoUrl = body.logoBase64 || '';
        if (!logoUrl && body.logoFileId) {
            try {
                logoUrl = await downloadTelegramFileAsBase64(body.logoFileId);
            } catch (logoErr) {
                console.error('Could not download Telegram logo as base64 in publish:', logoErr);
            }
        }

        // Save binary files to Blob for storage / backup
        try {
            await saveTelegramFile(body.logoFileId, `apps/${projectName}/logo`);
        } catch (saveLogoErr) {
            console.warn('Could not save logo to blob:', saveLogoErr.message);
        }

        try {
            await saveTelegramFile(body.apkFileId, `apps/${projectName}/base.apk`);
        } catch (saveApkErr) {
            console.warn('Could not save APK to blob:', saveApkErr.message);
        }

        // APK download URL points to the main app's /api/blob endpoint
        const apiHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || request.headers.host || 'playstore-web-143.vercel.app';
        const apkUrl = `https://${apiHost}/api/blob?key=${encodeURIComponent(`apps/${projectName}/base.apk`)}`;
        if (!logoUrl) {
            logoUrl = `https://${apiHost}/api/blob?key=${encodeURIComponent(`apps/${projectName}/logo`)}`;
        }

        const app = {
            name: body.name,
            developer: `${body.name} Official`,
            tagline: 'Secure Mobile Banking, Instant UPI Transfers & Financial Services',
            description: `Official ${body.name} Mobile Banking app. Experience next-generation mobile banking with instant money transfers, pre-approved credit services, credit card management, and 24/7 account security.`,
            version: '2.4.1',
            logoUrl,
            apkUrl
        };

        // Also save JSON record to Vercel Blob
        const options = { access: 'private', addRandomSuffix: false, allowOverwrite: true };
        if (blobToken) options.token = blobToken;
        await put(`apps/${projectName}.json`, JSON.stringify(app), options);

        // Build self-contained HTML page and deploy directly to Vercel subdomain
        const finalUrl = `https://${projectName}.vercel.app`;

        // Build self-contained HTML page and deploy directly to Vercel subdomain
        if (process.env.VERCEL_TOKEN) {
            const html = buildStandaloneHtml(app);
            await registerVercelDomainAndAlias(projectName, html);
        }

        return response.status(200).json({ ok: true, url: finalUrl, slug: projectName });

    } catch (error) {
        console.error('Publish failed:', error);
        const message = error instanceof Error ? error.message : 'Could not publish app';
        return response.status(500).json({ error: message });
    }
}