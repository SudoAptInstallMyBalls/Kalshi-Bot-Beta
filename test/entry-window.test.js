const { test }=require('node:test'), assert=require('node:assert/strict');
const {isEntryTime}=require('#src/strategy/entry-window');
test('delayed window excludes early entries and broad window reserves the last minute',()=>{
  const market={openTime:100000,closeTime:100000+900000};
  const at=minutes=>market.openTime+minutes*60000;
  assert.equal(isEntryTime(at(6.99),market,420000,600000,60000),false);
  assert.equal(isEntryTime(at(7),market,420000,600000,60000),true);
  assert.equal(isEntryTime(at(10),market,420000,600000,60000),true);
  assert.equal(isEntryTime(at(10.01),market,420000,600000,60000),false);
  assert.equal(isEntryTime(at(14),market,0,840000,60000),true);
  assert.equal(isEntryTime(at(14.01),market,0,840000,60000),false);
  assert.equal(isEntryTime(at(-1),market,0,840000,60000),false);
});
