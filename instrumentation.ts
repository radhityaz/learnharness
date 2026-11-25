/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
		// Materi inbox: PDFs dropped into <data>/materi-inbox/<matkul>/ are indexed on their own.
		try { (await import("./src/server/materi-ingest.ts")).startMateriInbox(); }
		catch (error) { console.error("[materi] Inbox watcher did not start:", error); }
	}
}
