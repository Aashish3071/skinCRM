/**
 * Create a new root key, wrapped by AWS KMS (D-93).
 *
 *   KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/… pnpm crypto:new-key
 *
 * Prints the wrapped key (base64). Put it in CRYPTO_WRAPPED_KEY with
 * CRYPTO_PROVIDER=aws-kms. The plaintext key is never printed or stored: only
 * the process holding kms:Decrypt on that KMS key can use it.
 *
 * Moving from a local key, or rotating: move the old value into
 * CRYPTO_PREVIOUS_MASTER_KEYS (local) or CRYPTO_PREVIOUS_WRAPPED_KEYS (KMS),
 * restart, then run `pnpm db:rotate-keys`.
 */
import { getEnv } from "@skincrm/config";

async function main(): Promise<void> {
  const keyId = getEnv().KMS_KEY_ID;
  if (!keyId) throw new Error("Set KMS_KEY_ID to the AWS KMS key (ARN or alias) that should wrap the new key.");
  const { KMSClient, GenerateDataKeyWithoutPlaintextCommand } = await import("@aws-sdk/client-kms");
  const out = await new KMSClient({}).send(new GenerateDataKeyWithoutPlaintextCommand({ KeyId: keyId, KeySpec: "AES_256" }));
  if (!out.CiphertextBlob) throw new Error("KMS did not return a wrapped key.");
  console.log("CRYPTO_PROVIDER=aws-kms");
  console.log(`CRYPTO_WRAPPED_KEY=${Buffer.from(out.CiphertextBlob).toString("base64")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
