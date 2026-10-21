import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateBundle,calculatorKey,initialCalculator} from '../src/pricing.js';
const calculate=keys=>keys.reduce(calculatorKey,{...initialCalculator});
test('bundle sums four prices and subtracts the selected percentage',()=>{
 const r=calculateBundle(['10','20','30','40'],'20');assert.equal(r.valid,true);assert.equal(r.count,4);assert.equal(r.subtotalCents,10000);assert.equal(r.discountCents,2000);assert.equal(r.totalCents,8000);
 const more=calculateBundle(['10','20','30','40','50'],'12.5');assert.equal(more.count,5);assert.equal(more.totalCents,13125);
});
test('bundle uses exact cents with fractional discounts and half-cent rounding',()=>{
 assert.equal(calculateBundle(['.10','.20'],'0').totalCents,30);
 assert.equal(calculateBundle(['19.99'],'12.5').discountCents,250);
 const half=calculateBundle(['.01'],'50');assert.equal(half.discountCents,1);assert.equal(half.totalCents,0);
 const r=calculateBundle(['10.10','20.20','5','.25'],'10');assert.equal(r.subtotalCents,3555);assert.equal(r.discountCents,356);assert.equal(r.totalCents,3199);
});
test('empty slots are ignored, zero prices count as pins, and discount endpoints work',()=>{
 assert.equal(calculateBundle(['','','',''],'10').count,0);assert.equal(calculateBundle(['10','','0',''],'0').count,2);
 assert.equal(calculateBundle(['10'],'0').totalCents,1000);assert.equal(calculateBundle(['10'],'100').totalCents,0);
});
test('invalid prices and percentages invalidate the quote instead of silently producing a misleading price',()=>{
 for(const price of ['-1','1.001','bad','1e2','1000000001']){const r=calculateBundle([price],'10');assert.equal(r.valid,false);assert.ok(r.errors[0]);assert.equal(r.totalCents,undefined);}
 for(const rate of ['','-1','101','1.001','NaN']){const r=calculateBundle(['10'],rate);assert.equal(r.valid,false);assert.ok(r.rateError);}
});
test('basic calculator handles decimal arithmetic, repeated operators and immediate chaining',()=>{
 assert.equal(calculate(['1','2','.','5','+','7','.','5','=']).display,'20');
 assert.equal(calculate(['0','.','1','+','0','.','2','=']).display,'0.3');
 assert.equal(calculate(['2','+','3','*','4','=']).display,'20');assert.equal(calculate(['2','+','*','3','=']).display,'6');
});
test('calculator percent follows ordinary discount and percent-of calculations',()=>{
 assert.equal(calculate(['2','0','0','-','1','0','%','=']).display,'180');
 assert.equal(calculate(['2','0','0','+','1','0','%','=']).display,'220');
 assert.equal(calculate(['2','0','0','*','1','0','%','=']).display,'20');assert.equal(calculate(['5','0','%']).display,'0.5');
});
test('calculator clear, sign and backspace work, and division by zero recovers on the next number',()=>{
 assert.equal(calculate(['1','2','3','backspace']).display,'12');assert.equal(calculate(['5','+/-','*','2','=']).display,'-10');assert.equal(calculate(['9','AC']).display,'0');
 const error=calculate(['5','/','0','=']);assert.match(error.error,/divide by zero/);assert.equal(calculatorKey(error,'7').display,'7');assert.equal(calculatorKey(error,'7').error,'');
 assert.equal(calculate(['9','/','3','=']).display,'3');
});
