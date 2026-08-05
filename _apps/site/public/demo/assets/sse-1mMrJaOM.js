async function*e(e){let t=e.getReader(),n=new TextDecoder,r=``;for(;;){let{done:e,value:i}=await t.read();if(e)break;r+=n.decode(i,{stream:!0});let a=r.indexOf(`

`);for(;a!==-1;)yield r.slice(0,a),r=r.slice(a+2),a=r.indexOf(`

`)}}var t=e=>{let t=e.split(`
`).find(e=>e.startsWith(`data:`));if(t===void 0)return;let n=t.slice(5).trim();if(n.length!==0)try{return JSON.parse(n)}catch{return}};export{e as n,t};