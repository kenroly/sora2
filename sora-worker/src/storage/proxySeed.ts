const rawProxyList = [
  'dancu337.proxydancu.xyz:9027:user_n7q:2uU5nNdd',
  'dancu337.proxydancu.xyz:9028:user_rq8:4dyn6Gul',
  'dancu337.proxydancu.xyz:9128:user_bpW:TltImjwJ',
  'dancu337.proxydancu.xyz:9130:user_aci:Zi5DOui1',
  'dancu337.proxydancu.xyz:9132:user_FLU:Se401Hjl',
  'dancu337.proxydancu.xyz:9133:user_A2v:miVLSPij',
  'dancu337.proxydancu.xyz:9134:user_Lfn:yt9G2AAk',
  'dancu337.proxydancu.xyz:9139:user_cgs:C7q2FbdD',
  'dancu337.proxydancu.xyz:9140:user_wXA:t9qH6r4v',
  'dancu337.proxydancu.xyz:9141:user_Qhn:ihoanVA7',
  'dancu337.proxydancu.xyz:9142:user_VN7:IizrD3GI',
  'dancu337.proxydancu.xyz:9143:user_WRv:EiRdos2n',
  'dancu337.proxydancu.xyz:9144:user_h0S:SDPjh42e',
  'dancu337.proxydancu.xyz:9145:user_fAH:huNigb0x',
  'dancu337.proxydancu.xyz:9146:user_gx8:tbxaSrNt',
  '64a-dohung64a-prx.proxydancu.xyz:8751:user_D6z:PTXddnKU',
  '64a-dohung64a-prx.proxydancu.xyz:8752:user_KSZ:0tvaYXSW',
  '64a-dohung64a-prx.proxydancu.xyz:10001:user_I3s:DF79BLfC',
  '64a-dohung64a-prx.proxydancu.xyz:10002:user_816:WTYFvS6e',
  '64a-dohung64a-prx.proxydancu.xyz:10011:user_NvI:RdJlCwaH'
] as const;

function toHttpProxy(entry: string): string {
  const [host, port, user, password] = entry.split(':');
  if (!host || !port || !user || !password) {
    throw new Error(`Invalid proxy entry: ${entry}`);
  }
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
}

export const defaultProxies = rawProxyList.map(toHttpProxy);

