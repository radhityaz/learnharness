/**
 * GET /api/materi/status — course-materials status: whether a materi index
 * is installed, per-course counts, the inbox folder, the Priming switch, and
 * the newest ingest outcomes. Local files only.
 *
 *   GET → 200 MateriStatus
 */

import { materiStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(materiStatus());
}
