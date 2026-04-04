"use strict";(()=>{var e={};e.id=16,e.ids=[16],e.modules={399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},421:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>N,patchFetch:()=>h,requestAsyncStorage:()=>_,routeModule:()=>d,serverHooks:()=>m,staticGenerationAsyncStorage:()=>c});var a={};r.r(a),r.d(a,{GET:()=>u});var s=r(5982),o=r(690),i=r(6585),n=r(6884),p=r(9726),l=r(619);async function u(e){let t=e.nextUrl.searchParams,r=t.get("limit")??"100",a=t.get("offset")??"0",s=t.get("hours")??"24",o=parseInt(r,10),i=parseInt(a,10),u=parseInt(s,10);if(isNaN(u)||u<1||u>168)return n.NextResponse.json({error:"Invalid hours parameter (1–168)"},{status:400});if(isNaN(o)||o<1)return n.NextResponse.json({error:"Invalid limit parameter"},{status:400});if(isNaN(i)||i<0)return n.NextResponse.json({error:"Invalid offset parameter"},{status:400});try{let e=`
      SELECT
        wa.*,
        t.side,
        t.proxy_wallet,
        m.question,
        m.slug
      FROM whale_alerts wa
      ${l.v}
      LEFT JOIN markets m ON m.token_id = wa.token_id
      WHERE wa.alerted_at >= NOW() - $1 * INTERVAL '1 hour'
      ORDER BY wa.alerted_at DESC
      LIMIT $2 OFFSET $3
    `,t=`
      SELECT COUNT(*) AS total
      FROM whale_alerts wa
      WHERE wa.alerted_at >= NOW() - $1 * INTERVAL '1 hour'
    `,[r,a]=await Promise.all([p.d.query(e,[u,Math.min(o,500),i]),p.d.query(t,[u])]);return n.NextResponse.json({alerts:r.rows,total:parseInt(a.rows[0].total,10)})}catch(e){return console.error("[api/alerts] DB error:",e),n.NextResponse.json({error:"Failed to fetch alerts"},{status:500})}}let d=new s.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/api/alerts/route",pathname:"/api/alerts",filename:"route",bundlePath:"app/api/alerts/route"},resolvedPagePath:"/Users/cedric/code/polymarket-alpha/apps/dashboard/app/api/alerts/route.ts",nextConfigOutput:"",userland:a}),{requestAsyncStorage:_,staticGenerationAsyncStorage:c,serverHooks:m}=d,N="/api/alerts/route";function h(){return(0,i.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:c})}},619:(e,t,r)=>{r.d(t,{v:()=>a});let a=`
LEFT JOIN trades t ON
  t.transaction_hash = split_part(wa.trade_lookup_key, '|', 1)
  AND t.token_id     = split_part(wa.trade_lookup_key, '|', 2)
  AND t.proxy_wallet = split_part(wa.trade_lookup_key, '|', 3)
  AND t.traded_at    = split_part(wa.trade_lookup_key, '|', 4)::timestamptz
  AND t.price_usdc   = split_part(wa.trade_lookup_key, '|', 5)::numeric
  AND t.size_tokens  = split_part(wa.trade_lookup_key, '|', 6)::numeric
  AND t.traded_at   >= NOW() - INTERVAL '90 days'
`.trim()},9726:(e,t,r)=>{r.d(t,{d:()=>s});let a=require("pg"),s=globalThis.__pgPool??(globalThis.__pgPool=function(){let e=process.env.DATABASE_URL;if(!e)throw Error("DATABASE_URL is not set");return new a.Pool({connectionString:e})}())}};var t=require("../../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),a=t.X(0,[609,985],()=>r(421));module.exports=a})();