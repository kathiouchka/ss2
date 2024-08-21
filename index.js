import axios from 'axios';
import { searcher } from 'jito-ts';
const { searcherClient: createSearcherClient } = searcher;
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils.js';
import { Wallet } from '@project-serum/anchor';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { getAssociatedTokenAddress } from "@solana/spl-token";

dotenv.config();

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is not set.');
}
const LOG_LEVELS = {
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error'
};

const RPC_ENDPOINT = `https://mainnet.helius-rpc.com/?api-key=${process.env.API_KEY}`;
const BLOCK_ENGINE_URL = 'frankfurt.mainnet.block-engine.jito.wtf';

const connection = new Connection(RPC_ENDPOINT, 'confirmed', {
    commitment: 'confirmed',
    timeout: 10000
});

const walletSend = new Wallet(Keypair.fromSecretKey(bs58.decode(privateKey)));
const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
const searcherClient = createSearcherClient(BLOCK_ENGINE_URL);

const solAddress = "So11111111111111111111111111111111111111112";
const SOLANA_GAS_FEE_PRICE = 0.000005 * LAMPORTS_PER_SOL;
const JITO_TIP_AMOUNT = 0.00001 * LAMPORTS_PER_SOL;

const requiredEnvVars = [
    'PRIVATE_KEY',
    'API_KEY',
];

function checkEnvVariables() {
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        logTransaction(LOG_LEVELS.ERROR, "Missing environment variables", { missingVars });
        process.exit(1);
    }
}

// Centralized logging function
function logTransaction(level, message, details = {}) {
    console.log(`[${level.toUpperCase()}] ${message}`, {
        ...details,
        timestamp: new Date().toISOString(),
        isBot: true,
    });
}

async function getTokenInfo(mint) {
    try {
        const jupiterApiUrl = `https://price.jup.ag/v6/price?ids=${mint}&vsToken=SOL`;
        // const dexScreenerApiUrl = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

        // Fetch price from Jupiter API
        const fetchFromJupiter = async () => {
            const response = await axios.get(jupiterApiUrl);
            if (response.data && response.data.data && response.data.data[mint]) {
                return {
                    price: response.data.data[mint].price,
                    source: "jupiter",
                };
            }
            throw new Error("Jupiter API failed to return a valid price.");
        };

        // Fetch price from DexScreener API
        const fetchFromDexScreener = async () => {
            const response = await axios.get(dexScreenerApiUrl);
            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Find a pair that uses SOL as the quote token
                const solPair = response.data.pairs.find(pair => pair.quoteToken.symbol === "SOL");
                if (solPair) {
                    return {
                        price: solPair.priceNative,
                        source: "dexscreener",
                    };
                }
            }
            throw new Error("DexScreener API failed to return a valid price.");
        };

        // Use Promise.race to get the fastest response
        const tokenInfo = await Promise.race([
            fetchFromJupiter(),
            // fetchFromDexScreener()
        ]);

        // Fetch mint account information to check if the token is freezable
        const mintAccountInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
        const freezeAuthority = mintAccountInfo.value.data.parsed.info.freezeAuthority;

        return {
            price: tokenInfo.price,
            source: tokenInfo.source,
            isFreezable: freezeAuthority !== null,
        };
    } catch (error) {
        logTransaction(LOG_LEVELS.ERROR, 'Error fetching token info', { error });
    }
    return null;
}


async function waitForPriceAvailability(tokenAddress) {
    while (true) {
        const tokenInfo = await getTokenInfo(tokenAddress);
        if (tokenInfo && tokenInfo.price) {
            logTransaction(LOG_LEVELS.INFO, `Price available for token ${tokenAddress}: ${tokenInfo.price} - fastest source ${tokenInfo.source}`);
            return tokenInfo.price;
        }
        logTransaction(LOG_LEVELS.WARN, `Price not available yet for ${tokenAddress}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1 second before checking again
    }
}

async function tradeTokenWithJupiter(tokenAddress, percentage, isBuy = true, slippage = 5, maxRetries = 3) {
    let retries = 0;
    let initialPrice = null;

    while (retries < maxRetries) {
        try {
            logTransaction(LOG_LEVELS.INFO, `Starting ${isBuy ? 'buy' : 'sell'} transaction for ${tokenAddress}`);

            let amount, inputMint, outputMint;

            if (isBuy) {
                const balance = await connection.getBalance(wallet.publicKey);
                amount = Math.floor(balance * (percentage / 100)) - SOLANA_GAS_FEE_PRICE - JITO_TIP_AMOUNT;
                inputMint = solAddress;
                outputMint = tokenAddress;

                if (amount < 0) {
                    logTransaction(LOG_LEVELS.ERROR, "Amount is less than gas fee and tip to Jito");
                    return false;
                }
            } else {
                const tokenPublicKey = new PublicKey(tokenAddress);
                const tokenAccount = await getAssociatedTokenAddress(tokenPublicKey, wallet.publicKey);
                const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
                amount = Math.floor(tokenBalance.value.uiAmount * (percentage / 100) * Math.pow(10, tokenBalance.value.decimals));
                inputMint = tokenAddress;
                outputMint = solAddress;
            }

            const response = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage * 100}`);
            if (!response.ok) {
                throw new Error(`HTTP quote error! status: ${response.statusText}`);
            }
            const routes = await response.json();

            const transaction_response = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: routes,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapUnwrapSOL: true,
                })
            });
            if (!transaction_response.ok) {
                throw new Error(`HTTP error! status: ${transaction_response.status}`);
            }
            const { swapTransaction } = await transaction_response.json();

            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([wallet]);

            const bundle = new Bundle([], 5);
            let maybeBundle = bundle.addTransactions(transaction);
            if (isError(maybeBundle)) {
                throw maybeBundle;
            }

            const tipAccounts = await searcherClient.getTipAccounts();
            const tipAccount = new PublicKey(tipAccounts[0]);
            const { blockhash } = await connection.getLatestBlockhash();
            maybeBundle = maybeBundle.addTipTx(wallet, JITO_TIP_AMOUNT, tipAccount, blockhash);
            if (isError(maybeBundle)) {
                throw maybeBundle;
            }

            logTransaction(LOG_LEVELS.INFO, 'Sending bundle...');
            const bundleUuid = await searcherClient.sendBundle(maybeBundle);

            if (bundleUuid) {
                logTransaction(LOG_LEVELS.INFO, `Bundle sent successfully ${bundleUuid}`);
                logTransaction(LOG_LEVELS.INFO, `${isBuy ? 'Buy' : 'Sell'} waiting confirmation.`);

                if (isBuy) {
                    const tokenInfo = await getTokenInfo(tokenAddress); // Capture the initial price when buying
                    initialPrice = tokenInfo ? tokenInfo.price : null;
                    logTransaction(LOG_LEVELS.INFO, `Initial Price: ${initialPrice}. Initiating sell...`);
                }

                return { success: true, initialPrice }; // Return the initial price
            } else {
                throw new Error('Bundle UUID not received');
            }
        } catch (error) {
            retries++;
            logTransaction(LOG_LEVELS.WARN, `Attempt ${retries} failed to send bundle to JITO: ${error.message}`);

            if (retries >= maxRetries) {
                logTransaction(LOG_LEVELS.ERROR, 'Max retries reached. Failed to send bundle to JITO', { error });
                return false;
            }

            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
        }
    }
}

// Function to check price periodically and sell if price increases by 2%
async function monitorAndSell(tokenAddress, initialPrice) {
    if (initialPrice === null) {
        logTransaction(LOG_LEVELS.ERROR, 'Failed to retrieve initial price, cannot monitor price changes.');
        return;
    }

    const threshold = initialPrice * 1.2; // 2% price increase

    while (true) {
        const currentPriceInfo = await getTokenInfo(tokenAddress);
        if (currentPriceInfo && currentPriceInfo.price >= threshold) {
            logTransaction(LOG_LEVELS.INFO, `Price target met! Current Price: ${currentPriceInfo.price}, Initial Price: ${initialPrice}. Initiating sell...`);
            await tradeTokenWithJupiter(tokenAddress, 100, false); // Sell 100% of the tokens
            break;
        }
        logTransaction(LOG_LEVELS.INFO, `Monitoring price... Current Price: ${currentPriceInfo ? currentPriceInfo.price : 'undefined'}, Waiting for: ${threshold}`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 60 seconds before checking again
    }
}

async function main() {
    try {
        checkEnvVariables();

        // Wait for the price to be available before attempting to buy
        const tokenAddress = ""; // Update with your target token
        await waitForPriceAvailability(tokenAddress);
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds delay
        // Execute token purchase and get the initial price
        const percentageToBuy = 6; // Example: Buy 5% of available SOL
        const result = await tradeTokenWithJupiter(tokenAddress, percentageToBuy, true);
        if (result && result.success) {
            await monitorAndSell(tokenAddress, result.initialPrice);
        }
    } catch (error) {
        logTransaction(LOG_LEVELS.ERROR, error.message);
    }
}

function handleGlobalErrors(error) {
    logTransaction(LOG_LEVELS.ERROR, `Unhandled error: ${error.message}`);
    logTransaction(LOG_LEVELS.ERROR, `Stack trace: ${error.stack}`);
  
    if (error.message.includes("503 Service Unavailable")) {
      logTransaction(LOG_LEVELS.WARN, "RPC service is currently unavailable. The program will continue running, but some operations may fail.");
    }
  
    setTimeout(() => {
      logTransaction(LOG_LEVELS.INFO, "Attempting to recover from error...");
      main().catch(handleGlobalErrors);
    }, 10000); // Wait 10 seconds before attempting to recover
}
  
main().catch(handleGlobalErrors);

// Add global error handlers
process.on('uncaughtException', handleGlobalErrors);
process.on('unhandledRejection', handleGlobalErrors);
