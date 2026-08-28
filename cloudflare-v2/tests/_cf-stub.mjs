// Maps `cloudflare:*` module specifiers to a harmless stub so worker source can be imported
// under plain Node for measurement harnesses (src/legacy/email.ts imports `cloudflare:sockets`).
import { registerHooks } from 'node:module';

const SOURCE = 'export const connect = () => { throw new Error("cloudflare:sockets is stubbed"); };\n'
  + 'export class DurableObject {}\n'
  + 'export default {};\n';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('cloudflare:')) return { url: specifier, shortCircuit: true, format: 'module' };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('cloudflare:')) return { format: 'module', source: SOURCE, shortCircuit: true };
    return nextLoad(url, context);
  }
});
