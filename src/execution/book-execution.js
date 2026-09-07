// Conservative displayed-depth diagnostic. No inferred passive/queue fills.
const {takerFee}=require('#src/risk/trading-math');
class Book {
  constructor(){this.valid=false;this.yes=new Map();this.no=new Map();this.ts=0;}
  apply(event,ts){
    const m=event.msg||{};
    if(['sequence_gap','capture_stop','connection_start','connection_closed','disconnected','connection_error'].includes(event.type)){this.valid=false;return;}
    if(event.type==='orderbook_snapshot'){
      if(!Array.isArray(m.yes_dollars_fp)||!Array.isArray(m.no_dollars_fp)){this.valid=false;return;}
      this.yes=new Map(m.yes_dollars_fp.map(([p,n])=>[Number(p),Number(n)]));
      this.no=new Map(m.no_dollars_fp.map(([p,n])=>[Number(p),Number(n)]));this.valid=true;this.ts=ts;
    }else if(event.type==='orderbook_delta'&&this.valid){
      const book=m.side==='yes'?this.yes:m.side==='no'?this.no:null;
      const price=Number(m.price_dollars),delta=Number(m.delta_fp);
      if(!book||!Number.isFinite(price)||!Number.isFinite(delta)){this.valid=false;return;}
      const quantity=(book.get(price)||0)+delta;
      if(quantity<0){this.valid=false;return;}if(quantity===0)book.delete(price);else book.set(price,quantity);this.ts=ts;
    }
    if([...this.yes,...this.no].some(([p,n])=>!Number.isFinite(p)||p<=0||p>=1||!Number.isFinite(n)||n<0))this.valid=false;
  }
  cross(side,limit,count,at,rate=.07){
    if(!this.valid||at<this.ts||at-this.ts>1000)return {filled:0,reason:'missing_or_stale_book'};
    const bids=side==='yes'?this.no:this.yes;
    let remaining=count,gross=0;
    for(const [bid,size]of [...bids].sort((a,b)=>b[0]-a[0])){
      const ask=1-bid;if(ask>limit+1e-9)break;
      const n=Math.min(remaining,Math.floor(size));gross+=n*ask;remaining-=n;if(!remaining)break;
    }
    const filled=count-remaining;
    return {filled,gross,estimatedFees:filled?takerFee(filled,gross/filled,rate):0,
      reason:remaining?'unfilled_remainder_cancel_at_timeout':'displayed_depth_cross'};
  }
}
module.exports={Book};
