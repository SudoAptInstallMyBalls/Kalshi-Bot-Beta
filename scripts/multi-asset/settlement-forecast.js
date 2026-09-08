const ProbabilityModel = require('../../src/agents/skills/analysis/probability-model');
const cdf = new ProbabilityModel();
function averageForecast({ now, closeTime, strike, currentPrice, sigma, observed = [], errorBps = 0, roundingUnit = 0.01 }) {
  if (![now, closeTime, strike, currentPrice, sigma, errorBps, roundingUnit].every(Number.isFinite) || strike <= 0 || currentPrice <= 0 || sigma <= 0 || errorBps < 0 || roundingUnit <= 0 || now > closeTime || closeTime % 1000 !== 0) return { ready:false, reason:'invalid_settlement_context' };
  const known = new Map();
  for (const r of observed) { if (r.timestamp <= now && r.received_ms <= now && Number.isFinite(r.price) && r.price > 0) { if (known.has(r.timestamp)) return {ready:false,reason:'duplicate_index_sample'}; known.set(r.timestamp,r.price); } }
  let sum=0, knownCount=0; const future=[];
  for(let i=0;i<60;i++){const t=closeTime-60000+i*1000;if(t<=now){if(!known.has(t))return{ready:false,reason:'missing_index_samples'};sum+=known.get(t);knownCount++;}else future.push((t-now)/1000);}
  const expected=(sum+future.length*currentPrice)/60; let covariance=0;for(const a of future)for(const b of future)covariance+=Math.min(a,b);
  const std=currentPrice*sigma/Math.sqrt(900)*Math.sqrt(covariance)/60,errorDollars=strike*errorBps/10000;
  const probability=value=>std===0?Number(Math.round(value/roundingUnit)*roundingUnit>=strike):cdf.normalCDF((value-(strike-roundingUnit/2))/std);
  const probUp=probability(expected);return{ready:true,volatilityKnown:true,probUp,probDown:1-probUp,lowerProbUp:probability(expected-errorDollars),upperProbUp:probability(expected+errorDollars),sigma,remainingSigma:std/strike,expectedSettlement:expected,knownCount,futureCount:future.length,errorBps,move:(expected-strike)/strike,movePct:(expected/strike-1)*100};
}
module.exports={averageForecast};
