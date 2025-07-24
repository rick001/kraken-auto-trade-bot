require('dotenv').config({ path: './.env' });
const krakenService = require('./src/services/krakenService');

async function verifyAllAssets() {
  try {
    console.log('🔍 Verifying all assets for USD markets and sell pair configurations...\n');

    // Initialize the service
    await krakenService.fetchTradablePairs();
    
    // Get account balance
    const balances = await krakenService.getAccountBalance();
    
    console.log(`📊 Found ${Object.keys(balances).length} assets in account\n`);

    const results = {
      verified: [],
      issues: [],
      zeroBalance: []
    };

    for (const [krakenAsset, amount] of Object.entries(balances)) {
      const balance = parseFloat(amount);
      const standardAsset = krakenService.getStandardAssetName(krakenAsset);
      
      if (balance === 0) {
        results.zeroBalance.push({
          krakenAsset,
          standardAsset,
          balance
        });
        continue;
      }

      // Skip USD (target currency)
      if (standardAsset === 'USD') {
        results.verified.push({
          krakenAsset,
          standardAsset,
          balance,
          status: 'SKIPPED',
          reason: 'Target currency',
          marketPair: null,
          minimumOrder: null
        });
        continue;
      }

      // Check if asset has USD market
      const hasMarket = krakenService.hasMarketPair(standardAsset);
      const marketPair = krakenService.getMarketPair(standardAsset);
      
      if (hasMarket && marketPair) {
        const pairInfo = krakenService.pairs[marketPair];
        const minimumOrder = parseFloat(pairInfo.ordermin);
        const canSell = balance >= minimumOrder;
        
        results.verified.push({
          krakenAsset,
          standardAsset,
          balance,
          status: canSell ? 'READY_TO_SELL' : 'INSUFFICIENT_BALANCE',
          reason: canSell ? 'Meets minimum order' : `Balance ${balance} < minimum ${minimumOrder}`,
          marketPair,
          minimumOrder,
          canSell
        });
      } else {
        results.issues.push({
          krakenAsset,
          standardAsset,
          balance,
          status: 'NO_MARKET',
          reason: 'No USD market found',
          marketPair: null,
          minimumOrder: null,
          hasMarket,
          marketPair
        });
      }
    }

    // Display results
    console.log('✅ VERIFIED ASSETS (Ready to sell or insufficient balance):');
    console.log('=' .repeat(80));
    if (results.verified.length === 0) {
      console.log('None found');
    } else {
      results.verified.forEach(asset => {
        const statusIcon = asset.status === 'READY_TO_SELL' ? '💰' : 
                          asset.status === 'INSUFFICIENT_BALANCE' ? '⚠️' : '⏭️';
        
        console.log(`${statusIcon} ${asset.standardAsset} (${asset.krakenAsset})`);
        console.log(`   Balance: ${asset.balance}`);
        console.log(`   Status: ${asset.status}`);
        console.log(`   Reason: ${asset.reason}`);
        
        if (asset.marketPair) {
          console.log(`   Market: ${asset.marketPair}`);
          console.log(`   Min Order: ${asset.minimumOrder}`);
          console.log(`   Can Sell: ${asset.canSell ? '✅ YES' : '❌ NO'}`);
        }
        console.log('');
      });
    }

    console.log('❌ ASSETS WITH ISSUES (No USD market):');
    console.log('=' .repeat(80));
    if (results.issues.length === 0) {
      console.log('None found');
    } else {
      results.issues.forEach(asset => {
        console.log(`🚨 ${asset.standardAsset} (${asset.krakenAsset})`);
        console.log(`   Balance: ${asset.balance}`);
        console.log(`   Status: ${asset.status}`);
        console.log(`   Reason: ${asset.reason}`);
        console.log(`   Has Market: ${asset.hasMarket ? 'YES' : 'NO'}`);
        console.log(`   Market Pair: ${asset.marketPair || 'None'}`);
        console.log('');
      });
    }

    console.log('📊 SUMMARY:');
    console.log('=' .repeat(80));
    console.log(`Total assets: ${Object.keys(balances).length}`);
    console.log(`Verified assets: ${results.verified.length}`);
    console.log(`Assets with issues: ${results.issues.length}`);
    console.log(`Zero balance assets: ${results.zeroBalance.length}`);

    // Count ready to sell
    const readyToSell = results.verified.filter(a => a.status === 'READY_TO_SELL').length;
    const insufficientBalance = results.verified.filter(a => a.status === 'INSUFFICIENT_BALANCE').length;
    const skipped = results.verified.filter(a => a.status === 'SKIPPED').length;

    console.log(`\n📈 BREAKDOWN:`);
    console.log(`   Ready to sell: ${readyToSell}`);
    console.log(`   Insufficient balance: ${insufficientBalance}`);
    console.log(`   Skipped (target currency): ${skipped}`);
    console.log(`   No market: ${results.issues.length}`);

    if (results.issues.length > 0) {
      console.log('\n🚨 CRITICAL ISSUES FOUND:');
      console.log('The following assets cannot be auto-sold to USD:');
      results.issues.forEach(asset => {
        console.log(`   - ${asset.standardAsset} (${asset.krakenAsset}): ${asset.balance}`);
      });
    }

    if (insufficientBalance > 0) {
      console.log('\n⚠️  INSUFFICIENT BALANCE ISSUES:');
      console.log('The following assets have markets but insufficient balance:');
      results.verified
        .filter(a => a.status === 'INSUFFICIENT_BALANCE')
        .forEach(asset => {
          console.log(`   - ${asset.standardAsset}: ${asset.balance} < ${asset.minimumOrder}`);
        });
    }

    console.log('\n✅ Verification complete');

  } catch (error) {
    console.error('❌ Error verifying assets:', error.message);
  }
}

verifyAllAssets().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
}); 