export function analysisConfig(env=process.env) {
  const integer = (name, min, max) => {
    const value=Number(env[name]);
    if (!Number.isSafeInteger(value)||value<min||value>max) throw Error('ANALYSIS_DISABLED');
    return value;
  };
  const model=env.GEMINI_MODEL;
  const pricingExpires=Date.parse(env.ANALYSIS_PRICING_EXPIRES_AT??'');
  if (!Number.isFinite(pricingExpires)||Date.now()>=pricingExpires) throw Error('ANALYSIS_DISABLED');
  if (env.ANALYSIS_ENABLED!=='true'||!env.GEMINI_API_KEY||!/^gemini-[a-z0-9.-]+$/.test(model??'')) {
    throw Error('ANALYSIS_DISABLED');
  }
  return {
    model,
    inputRate:integer('GEMINI_INPUT_MICROS_PER_TOKEN',1,1000),
    outputRate:integer('GEMINI_OUTPUT_MICROS_PER_TOKEN',1,1000),
    monthlyMicros:integer('ANALYSIS_MONTHLY_MICROS',1,100000000),
  };
}
