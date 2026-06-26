import { queryScheduledDue } from "./lib/ledger";
import { publishNow } from "./publishArticle";

/** Cron: publish every SCHEDULED article whose scheduleAt is now due. */
export async function handler(): Promise<{ published: number }> {
  const due = await queryScheduledDue(new Date().toISOString());
  for (const record of due) {
    try {
      await publishNow(record, record.targets!, record.seriesLink ?? "");
      console.log(`[publishScheduled] published ${record.repoName}`);
    } catch (err) {
      console.error(`[publishScheduled] failed ${record.repoName}:`, err);
    }
  }
  return { published: due.length };
}
