"use strict";(()=>{var e={};e.id=820,e.ids=[820],e.modules={399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},2629:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>c,patchFetch:()=>g,requestAsyncStorage:()=>_,routeModule:()=>p,serverHooks:()=>m,staticGenerationAsyncStorage:()=>d});var r={};s.r(r),s.d(r,{GET:()=>l});var o=s(5982),n=s(690),a=s(6585),i=s(6884),u=s(9726);async function l(e){let t=parseInt(e.nextUrl.searchParams.get("hours")??"24",10);if(isNaN(t)||t<1)return i.NextResponse.json({error:"Invalid hours parameter"},{status:400});t=Math.min(t,168);try{let e=`
      SELECT
        s.token_id,
        COUNT(*)::integer AS signal_count,
        COUNT(CASE WHEN s.signal_type = 'WHALE_TRADE' THEN 1 END)::integer AS whale_count,
        m.question,
        m.slug,
        ms.volume_24hr AS volume_24h
      FROM signals s
      LEFT JOIN markets m ON m.token_id = s.token_id
      LEFT JOIN market_stats ms ON ms.token_id = s.token_id
      WHERE s.created_at >= NOW() - $1 * INTERVAL '1 hour'
      GROUP BY s.token_id, m.question, m.slug, ms.volume_24hr
      ORDER BY signal_count DESC
      LIMIT 20
    `,s=(await u.d.query(e,[t])).rows;if(0===s.length)return i.NextResponse.json({markets:[]});let r=s.map(e=>e.token_id),o=`
      SELECT DISTINCT ON (s.token_id)
        s.token_id,
        s.signal_type AS top_signal_type
      FROM signals s
      WHERE s.created_at >= NOW() - $1 * INTERVAL '1 hour'
        AND s.token_id = ANY($2)
      GROUP BY s.token_id, s.signal_type
      ORDER BY s.token_id,
               COUNT(*) DESC,
               MAX(s.confidence) DESC NULLS LAST,
               s.signal_type ASC
    `,n=await u.d.query(o,[t,r]),a=new Map;for(let e of n.rows)a.set(e.token_id,e.top_signal_type);let l=s.map(e=>({token_id:e.token_id,question:e.question,slug:e.slug,signal_count:e.signal_count,whale_count:e.whale_count,top_signal_type:a.get(e.token_id)??null,volume_24h:e.volume_24h}));return i.NextResponse.json({markets:l})}catch(e){return console.error("[api/markets] DB error:",e),i.NextResponse.json({error:"Failed to fetch markets"},{status:500})}}let p=new o.AppRouteRouteModule({definition:{kind:n.x.APP_ROUTE,page:"/api/markets/route",pathname:"/api/markets",filename:"route",bundlePath:"app/api/markets/route"},resolvedPagePath:"/Users/cedric/code/polymarket-alpha/apps/dashboard/app/api/markets/route.ts",nextConfigOutput:"",userland:r}),{requestAsyncStorage:_,staticGenerationAsyncStorage:d,serverHooks:m}=p,c="/api/markets/route";function g(){return(0,a.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:d})}},9726:(e,t,s)=>{s.d(t,{d:()=>o});let r=require("pg"),o=globalThis.__pgPool??(globalThis.__pgPool=function(){let e=process.env.DATABASE_URL;if(!e)throw Error("DATABASE_URL is not set");return new r.Pool({connectionString:e})}())}};var t=require("../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),r=t.X(0,[609,985],()=>s(2629));module.exports=r})();