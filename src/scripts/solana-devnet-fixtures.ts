/**
 * Creates the Solana devnet tokens the settlement desk's fixtures use, from
 * Shield's devnet wallet (SOLANA_DEVNET_KEY). Devnet only; nothing has value.
 *
 *   npx tsx src/scripts/solana-devnet-fixtures.ts
 *
 * 1. tUSD: a plain SPL token, 6 decimals, like USDC (a stand-in while the
 *    Circle devnet faucet is rate-limited). 1,000 minted to the wallet.
 * 2. rUSD: a Token-2022 dollar whose issuer keeps a permanent delegate, the
 *    power to move or burn tokens out of any holder's account (PayPal's PYUSD
 *    on Solana mainnet has one). 1,000 minted to the wallet.
 * Prints the mint addresses; they are recorded in telegraph/SETTLEMENT.md.
 */
import { Connection, Keypair, sendAndConfirmTransaction, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { devnetKeypair, SOLANA_RPCS } from '../shield/solana.js';

const payer = devnetKeypair();
if (!payer) throw new Error('SOLANA_DEVNET_KEY is not set');
const conn = new Connection(SOLANA_RPCS['solana-devnet'][0]!, 'confirmed');
const DECIMALS = 6;
const SUPPLY = 1_000n * 10n ** BigInt(DECIMALS);

async function createToken(label: string, programId: typeof TOKEN_PROGRAM_ID, extensions: ExtensionType[]): Promise<string> {
  const mint = Keypair.generate();
  const len = getMintLen(extensions);
  const lamports = await conn.getMinimumBalanceForRentExemption(len);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, payer!.publicKey, false, programId);
  const tx = new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer!.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports, programId }));
  if (extensions.includes(ExtensionType.PermanentDelegate)) {
    tx.add(createInitializePermanentDelegateInstruction(mint.publicKey, payer!.publicKey, programId));
  }
  tx.add(
    createInitializeMintInstruction(mint.publicKey, DECIMALS, payer!.publicKey, payer!.publicKey, programId),
    createAssociatedTokenAccountIdempotentInstruction(payer!.publicKey, ata, payer!.publicKey, mint.publicKey, programId),
    createMintToInstruction(mint.publicKey, ata, payer!.publicKey, SUPPLY, [], programId),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [payer!, mint], { commitment: 'finalized' });
  console.log(`${label}: mint ${mint.publicKey.toBase58()} (tx ${sig})`);
  return mint.publicKey.toBase58();
}

await createToken('tUSD (SPL, plain)', TOKEN_PROGRAM_ID, []);
await createToken('rUSD (Token-2022, permanent delegate)', TOKEN_2022_PROGRAM_ID, [ExtensionType.PermanentDelegate]);
