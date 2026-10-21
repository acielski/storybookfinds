// Keep bundle arithmetic in cents; percentages support two decimal places.
export function calculateBundle(prices,percentage){
  const errors={};let subtotalCents=0,count=0;
  prices.forEach((value,index)=>{
    const text=String(value).trim();if(!text)return;
    if(!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)||Number(text)>1e9){errors[index]='Use a price from $0 to $1 billion, with up to 2 decimal places.';return;}
    const [whole='',fraction='']=text.split('.');const cents=Number(whole||0)*100+Number(fraction.padEnd(2,'0'));
    subtotalCents+=cents;count++;
  });
  const rate=String(percentage).trim();
  const rateError=!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(rate)||Number(rate)>100?'Choose a discount from 0% to 100%, with up to 2 decimal places.':null;
  if(!Number.isSafeInteger(subtotalCents))throw Error('This bundle total is too large.');
  if(Object.keys(errors).length||rateError)return {errors,rateError,count,valid:false};
  const [whole='',fraction='']=rate.split('.');const basisPoints=Number(whole||0)*100+Number(fraction.padEnd(2,'0'));
  const discountCents=Number((BigInt(subtotalCents)*BigInt(basisPoints)+5000n)/10000n);
  return {valid:true,errors,rateError:null,count,subtotalCents,discountCents,totalCents:subtotalCents-discountCents,percentage:Number(rate)};
}

export const initialCalculator={display:'0',accumulator:null,operator:null,fresh:true,error:''};
const format=value=>{
  if(!Number.isFinite(value))throw Error('That result is too large.');
  return String(Number(value.toPrecision(12)));
};
function operate(a,b,operator){
  if(operator==='+' )return a+b;
  if(operator==='-' )return a-b;
  if(operator==='*' )return a*b;
  if(operator==='/'){if(b===0)throw Error('Cannot divide by zero.');return a/b;}
  return b;
}
export function calculatorKey(state,key){
  if(key==='AC')return {...initialCalculator};
  if(state.error)state={...initialCalculator};
  try{
    if(/^\d$/.test(key)){
      const display=state.fresh?key:state.display==='0'?key:state.display==='-0'?'-'+key:state.display+key;
      return display.replace(/[^\d]/g,'').length>16?state:{...state,display,fresh:false};
    }
    if(key==='.')return state.fresh?{...state,display:'0.',fresh:false}:state.display.includes('.')?state:{...state,display:state.display+'.'};
    if(key==='backspace')return {...state,display:state.fresh?'0':state.display.slice(0,-1).replace(/^-$/,'')||'0',fresh:false};
    if(key==='+/-')return {...state,display:state.display.startsWith('-')?state.display.slice(1):'-'+state.display,fresh:false};
    if(key==='%'){
      const value=Number(state.display)/100;
      return {...state,display:format(state.operator==='+'||state.operator==='-'?state.accumulator*value:value),fresh:false};
    }
    if(['+','-','*','/'].includes(key)){
      const value=state.operator&&!state.fresh?operate(state.accumulator,Number(state.display),state.operator):Number(state.display);
      return {...state,display:format(value),accumulator:value,operator:key,fresh:true};
    }
    if(key==='='&&state.operator){const value=operate(state.accumulator,Number(state.display),state.operator);return {...initialCalculator,display:format(value)};}
    return state;
  }catch(error){return {...initialCalculator,error:error.message};}
}
