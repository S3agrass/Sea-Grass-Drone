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

	// Local mirror of what the caller last saw, so a change can be applied to it
	// instead of re-reading the table.
	let items = [];
	let closed = false;

	const emit = () => {
		items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
		cb([...items]);
	};

	// Full read. Runs once at mount and again whenever the socket (re)subscribes,
	// which is the moment incremental state could have drifted — anything that
	// changed while the connection was down produced no event to apply.
	const load = async () => {
		let q = supabase.from("media").select("*").order("captured_at", { ascending: false });
		if (droneId) q = q.eq("drone_id", droneId);
		const { data, error } = await q;
		if (closed) return;
		if (error) onError?.(error);
		else {
			items = (data || []).map(toItem);
			emit();
		}
	};

	// Apply one row change rather than re-reading everything.
	//
	// This used to call load() on every event. During an upload backlog drain —
	// a drone surfacing after a dive, which is the entire reason this
	// subscription exists — n inserted rows meant n complete re-downloads of a
	// list that is at its largest precisely then. Quadratic, and worst exactly
	// when it matters.
	const apply = (payload) => {
		if (closed) return;
		const row = payload.new;
		const gone = payload.old;

		if (payload.eventType === "DELETE") {
			// Delete payloads carry only the primary key unless the table is set
			// to REPLICA IDENTITY FULL, which is why this matches on id alone.
			if (gone?.id) items = items.filter((i) => i.id !== gone.id);
			return emit();
		}
		if (!row?.id) return;
		// Belt and braces: the channel is already filtered server-side when a
		// drone is selected, but a fleet-wide subscription sees everything the
		// caller may read, and a row could arrive for another drone.
		if (droneId && row.drone_id !== droneId) return;

		const item = toItem(row);
		const at = items.findIndex((i) => i.id === item.id);
		if (at === -1) items.push(item);
		else items[at] = item;
		emit();
	};

	load();

	// Realtime must be enabled for the table in the Supabase dashboard. If it
	// isn't, the initial load above still works — the page just won't update
	// until refreshed, which is a degradation rather than a failure.
	//
	// Channel name includes the drone so two mounts don't collide on one topic.
	const channel = supabase
		.channel(`media-changes:${droneId || "all"}`)
		.on(
			"postgres_changes",
			{
				event: "*",
				schema: "public",
				table: "media",
				// Server-side filter: without it every client is woken for every
				// row in the table and discards most of them.
				...(droneId ? { filter: `drone_id=eq.${droneId}` } : {}),
			},
			apply,
		)
		.subscribe((status) => {
			// Reconcile on (re)connect. Events that happened while the socket was
			// down were never delivered, so the mirror can be stale.
			if (status === "SUBSCRIBED") load();
		});

	return () => {
		closed = true;
		supabase.removeChannel(channel);
	};
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
