/**
 * Re-encrypt stored secrets under the current key (D-93).
 *
 *   pnpm db:rotate-keys
 *
 * Run after adding a new key with the old one listed in
 * CRYPTO_PREVIOUS_WRAPPED_KEYS / CRYPTO_PREVIOUS_MASTER_KEYS. When it reports
 * nothing unreadable, the old key can be removed from configuration.
 */
import { initCrypto } from "@skincrm/security";
import { closeAllConnections, getOwnerDb } from "../client";
import { rotateEncryptionKeys } from "../rotate-keys";

async function main(): Promise<void> {
  await initCrypto();
  const report = await rotateEncryptionKeys(getOwnerDb().db);
  console.log(`Re-encrypted ${report.reencrypted} value(s); ${report.alreadyCurrent} already used the current key.`);
  if (report.unreadable.length) {
    console.log(`${report.unreadable.length} value(s) could not be decrypted with any configured key — keep the old key until these are resolved:`);
    for (const u of report.unreadable.slice(0, 50)) console.log(`  ${u.table} ${u.id}`);
    process.exitCode = 2;
  } else {
    console.log("Nothing left on an old key. The previous key can be removed from configuration.");
  }
}

main()
  .then(() => closeAllConnections())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeAllConnections().catch(() => {});
    process.exit(1);
  });
