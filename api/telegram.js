import { get, put, del } from '@vercel/blob';
import { buildStandaloneHtml } from '../lib/template.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

async function telegram(method, body) {
	if (!token) {
		console.error('TELEGRAM_BOT_TOKEN is missing');
		return { ok: false, description: 'Token missing' };
	}
	try {
		const result = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		return await result.json();
	} catch (err) {
		console.error(`Telegram API error (${method}):`, err);
		return { ok: false, error: err.message };
	}
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
	const blob = await put(path, await download.arrayBuffer(), options);
	return blob.url;
}

const sessionCache = new Map();

async function loadSession(chatId) {
	const key = String(chatId);
	if (sessionCache.has(key)) {
		const mem = sessionCache.get(key);
		if (mem && mem.data) return mem;
	}
	try {
		const options = { access: 'private' };
		if (blobToken) options.token = blobToken;
		const blob = await get(`sessions/${chatId}.json`, options);
		if (blob?.stream) {
			const text = await new Response(blob.stream).text();
			const parsed = JSON.parse(text);
			sessionCache.set(key, parsed);
			return parsed;
		}
	} catch (err) {
		// Session doesn't exist yet or Blob error
	}
	return { step: 'name', data: {} };
}

async function saveSession(chatId, session) {
	const key = String(chatId);
	sessionCache.set(key, session);
	try {
		const options = { access: 'private', addRandomSuffix: false, allowOverwrite: true };
		if (blobToken) options.token = blobToken;
		await put(`sessions/${chatId}.json`, JSON.stringify(session), options);
	} catch (err) {
		console.error('Error saving session to Blob:', err);
	}
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
		body: JSON.stringify({ name }),
	});
	if (result.ok || result.status === 409) return name;
	const text = await result.text();
	console.warn(`Vercel project creation (${result.status}):`, text);
	return name;
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
			projectSettings: { framework: null },
		}),
	});
	if (!result.ok) {
		const text = await result.text();
		throw new Error(`Vercel deploy failed (${result.status}): ${text}`);
	}
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
	if (!token) {
		console.error('TELEGRAM_BOT_TOKEN environment variable is missing on Vercel');
		return response.status(500).json({ error: 'TELEGRAM_BOT_TOKEN is missing' });
	}

	let update = request.body;
	if (typeof update === 'string') {
		try {
			update = JSON.parse(update);
		} catch {
			update = {};
		}
	}

	const message = update?.message || update?.edited_message;
	const callbackQuery = update?.callback_query;

	const chatId = message?.chat?.id || callbackQuery?.message?.chat?.id;
	if (!chatId) {
		return response.status(200).json({ ok: true });
	}

	try {
		if (callbackQuery) {
			await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id });
			if (callbackQuery.data === 'new_link') {
				await saveSession(chatId, { step: 'name', data: {} });
				await telegram('sendMessage', {
					chat_id: chatId,
					text: '✅ Process restarted\n\n1/3 App ka naam Bhejiye.',
				});
				return response.status(200).json({ ok: true });
			}
		}

		const text = (message?.text || message?.caption || '').trim();
		const isImagePhoto = Array.isArray(message?.photo) && message.photo.length > 0;
		const isImageDoc = !!(
			message?.document?.mime_type?.startsWith('image/') ||
			/\.(png|jpg|jpeg|webp|svg|bmp)$/i.test(message?.document?.file_name || '')
		);
		const isApkDoc = !!(
			message?.document?.file_name?.toLowerCase().endsWith('.apk') ||
			message?.document?.mime_type === 'application/vnd.android.package-archive'
		);

		// Handle /start command
		if (text.startsWith('/start')) {
			await saveSession(chatId, { step: 'name', data: {} });
			await telegram('sendMessage', {
				chat_id: chatId,
				text: '✅ Process started\n\n1/3 App ka naam Bhejiye.',
			});
			return response.status(200).json({ ok: true });
		}

		const session = await loadSession(chatId);

		// 1. If user sent an Image/Photo (Step 2)
		if (isImagePhoto || isImageDoc) {
			let fileId;
			if (isImagePhoto) {
				const photos = message.photo;
				if (photos.length >= 3) fileId = photos[1].file_id;
				else if (photos.length === 2) fileId = photos[1].file_id;
				else fileId = photos[0].file_id;
			} else {
				fileId = message.document.file_id;
			}

			// If photo came with a caption and name wasn't set, use caption as app name!
			if (text && !text.startsWith('/') && (!session.data.name || session.data.name === 'App')) {
				session.data.name = text;
				session.data.developer = `${text} Official`;
			}

			await telegram('sendMessage', { chat_id: chatId, text: '⏳ Uploading logo image...' });
			session.data.logoFileId = fileId;
			try {
				session.data.logoBase64 = await downloadTelegramFileAsBase64(fileId);
			} catch (err) {
				console.error('Error generating logoBase64:', err);
			}
			session.data.logoUrl = await saveTelegramFile(fileId, `apps/${chatId}/logo`);
			session.step = 'apk';
			await saveSession(chatId, session);
			const displayName = session.data.name ? ` for [${session.data.name}]` : '';
			await telegram('sendMessage', {
				chat_id: chatId,
				text: `✅ 2/3 App logo received${displayName}\n\n3/3 Ab APK document bhejiye (.apk file).`,
			});
			return response.status(200).json({ ok: true });
		}

		// 2. If user sent an APK Document (Step 3)
		if (isApkDoc) {
			// If APK came with caption and name was not set
			if (text && !text.startsWith('/') && (!session.data.name || session.data.name === 'App')) {
				session.data.name = text;
				session.data.developer = `${text} Official`;
			}

			const docCleanName = (message?.document?.file_name || '')
				.replace(/\.apk$/i, '')
				.replace(/[^a-zA-Z0-9\s_-]/g, '')
				.trim();
			const appName = session.data.name || docCleanName || 'App';
			const slug = generateProjectSlug(appName);
			await telegram('sendMessage', {
				chat_id: chatId,
				text: '⏳ Uploading APK & creating standalone domain shortly .'
			});

			// Save APK permanently under the unique project slug
			session.data.apkUrl = await saveTelegramFile(message.document.file_id, `apps/${slug}/base.apk`);
			const host = request.headers.host || 'playstore-web-143.vercel.app';
			const apkUrl = `https://${host}/api/blob?key=${encodeURIComponent(`apps/${slug}/base.apk`)}`;

			// Resolve logo URL (prioritize inline base64 data URL for 100% instant rendering!)
			let logoUrl = session.data.logoBase64 || '';
			if (!logoUrl && session.data.logoFileId) {
				try {
					logoUrl = await downloadTelegramFileAsBase64(session.data.logoFileId);
				} catch (e) { }
			}
			if (!logoUrl) {
				// Check if user's chat logo exists in blob store
				try {
					const options = { access: 'private' };
					if (blobToken) options.token = blobToken;
					const chatLogoBlob = await get(`apps/${chatId}/logo`, options);
					if (chatLogoBlob?.stream) {
						const buf = Buffer.from(await new Response(chatLogoBlob.stream).arrayBuffer());
						if (buf.length > 0) {
							logoUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
						}
					}
				} catch (e) { }
			}

			if (session.data.logoFileId) {
				try {
					await saveTelegramFile(session.data.logoFileId, `apps/${slug}/logo`);
				} catch (e) { }
			}

			const appRecord = {
				name: appName,
				developer: session.data.developer || `${appName} Official`,
				tagline: 'Secure Mobile Banking, Instant UPI Transfers & Financial Services',
				description: `Official ${appName} Mobile Banking app. Experience next-generation mobile banking with instant money transfers, pre-approved credit services, credit card management, and 24/7 account security.`,
				version: '2.4.1',
				logoUrl,
				apkUrl,
				slug,
			};

			const options = { access: 'private', addRandomSuffix: false, allowOverwrite: true };
			if (blobToken) options.token = blobToken;
			await put(`apps/${slug}.json`, JSON.stringify(appRecord), options);

			const liveUrl = `https://${slug}.vercel.app`;

			// Deploy standalone project or register domain alias on Vercel
			if (vercelToken) {
				const html = buildStandaloneHtml(appRecord);
				await registerVercelDomainAndAlias(slug, html);
			}

			const replyMarkup = {
				inline_keyboard: [
					[
						{ text: '🆘 Help', url: 'https://t.me/sanaminfotech' },
						{ text: '➕ New Link', callback_data: 'new_link' },
					],
				],
			};

			await telegram('sendMessage', {
				chat_id: chatId,
				text: `🎉 Files uploaded\n✅ Page deployed & READY!\n\n🔗 ${liveUrl}`,
				reply_markup: replyMarkup,
			});

			try {
				sessionCache.delete(String(chatId));
				if (blobToken) options.token = blobToken;
				await del(`sessions/${chatId}.json`, options);
			} catch { }

			return response.status(200).json({ ok: true });
		}

		// 3. If user sent a non-APK document when expecting APK
		if (message?.document && !isApkDoc && !isImageDoc) {
			await telegram('sendMessage', {
				chat_id: chatId,
				text: '⚠️ Kripya valid .apk file bhejiye (.apk extension wali file).',
			});
			return response.status(200).json({ ok: true });
		}

		// 4. If user sent Text (Step 1: App Name)
		if (text && !text.startsWith('/')) {
			session.data.name = text;
			session.data.developer = `${text} Official`;
			session.step = 'logo';
			await saveSession(chatId, session);
			await telegram('sendMessage', {
				chat_id: chatId,
				text: `✅ 1/3 App name received: "${text}"\n\n2/3 Ab app ka logo / icon image Bhejiye.`,
			});
			return response.status(200).json({ ok: true });
		}

		// Fallback guidance
		await telegram('sendMessage', {
			chat_id: chatId,
			text: 'ℹ️ Current step ke hisaab se input bhejiye ya /start se dobara shuru karein.',
		});
	} catch (error) {
		console.error('Webhook processing error:', error);
		await telegram('sendMessage', {
			chat_id: chatId,
			text: `⚠️ Error occurred: ${error.message || 'Unknown error'}. Kripya /start se dobara try karein.`,
		});
	}

	return response.status(200).json({ ok: true });
}