"use strict";(()=>{var e={};e.id=582,e.ids=[582],e.modules={399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4478:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>k,patchFetch:()=>m,requestAsyncStorage:()=>_,routeModule:()=>u,serverHooks:()=>w,staticGenerationAsyncStorage:()=>c});var a={};r.r(a),r.d(a,{GET:()=>n});var s=r(5982),o=r(690),l=r(6585),p=r(6884),i=r(9726),d=r(619);async function n(e,{params:t}){let{address:r}=t;if(!r)return p.NextResponse.json({alerts:[]});let a=`
    SELECT wa.*, t.side, t.proxy_wallet, m.question, m.slug
    FROM whale_alerts wa
    ${d.v}
    LEFT JOIN markets m ON m.token_id = wa.token_id
    WHERE split_part(wa.trade_lookup_key, '|', 3) = $1
    ORDER BY wa.alerted_at DESC
    LIMIT 20
  `;try{let e=await i.d.query(a,[r]);return p.NextResponse.json({alerts:e.rows})}catch(e){return console.error("[api/wallets/[address]/alerts] DB error:",e),p.NextResponse.json({error:"Failed to fetch wallet alerts"},{status:500})}}let u=new s.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/api/wallets/[address]/alerts/route",pathname:"/api/wallets/[address]/alerts",filename:"route",bundlePath:"app/api/wallets/[address]/alerts/route"},resolvedPagePath:"/Users/cedric/code/polymarket-alpha/apps/dashboard/app/api/wallets/[address]/alerts/route.ts",nextConfigOutput:"",userland:a}),{requestAsyncStorage:_,staticGenerationAsyncStorage:c,serverHooks:w}=u,k="/api/wallets/[address]/alerts/route";function m(){return(0,l.patchFetch)({serverHooks:w,staticGenerationAsyncStorage:c})}},619:(e,t,r)=>{r.d(t,{v:()=>a});let a=`
LEFT JOIN trades t ON
  t.transaction_hash = split_part(wa.trade_lookup_key, '|', 1)
  AND t.token_id     = split_part(wa.trade_lookup_key, '|', 2)
  AND t.proxy_wallet = split_part(wa.trade_lookup_key, '|', 3)
  AND t.traded_at    = split_part(wa.trade_lookup_key, '|', 4)::timestamptz
  AND t.price_usdc   = split_part(wa.trade_lookup_key, '|', 5)::numeric
  AND t.size_tokens  = split_part(wa.trade_lookup_key, '|', 6)::numeric
  AND t.traded_at   >= NOW() - INTERVAL '90 days'
`.trim()},9726:(e,t,r)=>{r.d(t,{d:()=>s});let a=require("pg"),s=globalThis.__pgPool??(globalThis.__pgPool=function(){let e=process.env.DATABASE_URL;if(!e)throw Error("DATABASE_URL is not set");return new a.Pool({connectionString:e})}())}};var t=require("../../../../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),a=t.X(0,[609,985],()=>r(4478));module.exports=a})();