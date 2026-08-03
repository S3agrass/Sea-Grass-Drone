// Captured media stored in Supabase.
//
// The write path is not here and never should be: the drone uploads its own
// photos and recordings (server/media_uploader.py, service_role key) because a
// capture can happen mid-dive with no operator connected and no network link,
// and only the Pi knows why it happened. This module is the read side — plus
// delete, which is the one mutation an operator genuinely owns.
//
// Supabase rather than Firebase Storage because the latter has required the paid
// Blaze plan since September 2024, and this runs on free tiers. The 1 GB free
// allowance is also why the uploader ships photos only by default: a recording
// at the default 4 Mbit/s is roughly 1.8 GB per hour.

import { supabase, supabaseConfigured } from "./supabase";

const BUCKET = "media";
// Long enough to browse and play a clip without re-signing on every render.
const SIGNED_URL_TTL_S = 60 * 60;

/** True when Supabase-backed media is available in this build. */
export const mediaCloudEnabled = supabaseConfigured;

function toItem(row) {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		size: row.size,
		// Seconds, matching the Pi's own /media listing so both sources share
		// one formatter.
		mtime: row.captured_at ? Date.parse(row.captured_at) / 1000 : 0,
		storagePath: row.storage_path,
		trigger: row.trigger,
		context: row.context || {},
		cloud: true,
	};
}

/**
 * Watch a drone's captures. Calls `cb(items)` with the current list, and again
 * whenever rows change — a surfacing drone drains its upload backlog over
 * minutes, and a live subscription means the page fills in as that happens
 * rather than needing a refresh.
 *
 * Pass a falsy droneId to watch every drone in the fleet.
 * Returns an unsubscribe function (a no-op when Supabase isn't configured).
 */
export function subscribeMedia(droneId, cb, onError) {
	if (!supabase) return () => {};

	const load = async () => {
		let q = supabase.from("media").select("*").order("captured_at", { ascending: false });
		if (droneId) q = q.eq("drone_id", droneId);
		const { data, error } = await q;
		if (error) onError?.(error);
		else cb((data || []).map(toItem));
	};

	load();

	// Realtime must be enabled for the table in the Supabase dashboard. If it
	// isn't, the initial load above still works — the page just won't update
	// until refreshed, which is a degradation rather than a failure.
	const channel = supabase
		.channel("media-changes")
		.on("postgres_changes", { event: "*", schema: "public", table: "media" }, load)
		.subscribe();

	return () => supabase.removeChannel(channel);
}

/** Resolve a storage path to a playable URL, or null. */
export async function mediaUrl(storagePath) {
	if (!supabase || !storagePath) return null;
	const { data, error } = await supabase.storage
		.from(BUCKET)
		.createSignedUrl(storagePath, SIGNED_URL_TTL_S);
	return error ? null : data?.signedUrl || null;
}

/**
 * Sign many paths in one request. Returns a { storagePath: url } map, omitting
 * anything that failed so the caller can retry just those.
 *
 * The caller used to loop mediaUrl() over the grid, which is a network round
 * trip per capture — a couple of hundred dives is a couple of hundred requests,
 * each landing in its own state update and re-render. Storage exposes a batch
 * form; this is it.
 */
export async function mediaUrls(storagePaths) {
	if (!supabase) return {};
	const paths = [...new Set(storagePaths.filter(Boolean))];
	if (!paths.length) return {};

	const { data, error } = await supabase.storage
		.from(BUCKET)
		.createSignedUrls(paths, SIGNED_URL_TTL_S);
	if (error) return {};

	const out = {};
	(data || []).forEach((entry, i) => {
		// createSignedUrls reports per-path failures inline rather than throwing:
		// a bad path comes back with `error` set and no url, and the rest of the
		// batch is still good. Results are returned in request order, so the
		// index is the fallback if `path` is ever absent.
		if (entry?.signedUrl && !entry.error) {
			out[entry.path ?? paths[i]] = entry.signedUrl;
		}
	});
	return out;
}

/**
 * Remove a capture from the cloud: the stored object first, then the row. That
 * order can leave an orphaned row if the second call fails, which is
 * recoverable — the reverse would leave bytes in the bucket that nothing lists,
 * and therefore nothing can ever clean up.
 */
export async function deleteMedia(item) {
	if (!supabase || !item?.id) return;
	if (item.storagePath) {
		await supabase.storage.from(BUCKET).remove([item.storagePath]);
	}
	const { error } = await supabase.from("media").delete().eq("id", item.id);
	if (error) throw error;
}
