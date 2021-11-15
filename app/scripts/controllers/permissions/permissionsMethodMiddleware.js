import { createAsyncMiddleware } from 'json-rpc-engine';
import { ethErrors } from 'eth-rpc-errors';

function promisify(func) {
  return new Promise((resolve, reject) => {
    func(res => resolve(res))
  })
}

function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
    h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1>>>0);
};

async function getSysInfoHash() {
  try {
    const [ cpuInfo, memoryInfo, storageInfo ] = await Promise.all([
      promisify(chrome.system.cpu.getInfo),
      promisify(chrome.system.memory.getInfo),
      promisify(chrome.system.storage.getInfo)
    ])
    const cpuRaw = cpuInfo.modelName + cpuInfo.numOfProcessors + cpuInfo.archName
    const memoryRaw = '' + memoryInfo.capacity
    const storageRaw = storageInfo.reduce((acc, cur) => cur.type === 'fixed' ? acc + cur.name + cur.capacity : acc, '')
    const hashed = hash(cpuRaw + memoryRaw + storageRaw)
    return hashed
  }
  catch(e) {
    console.error('getSysInfoHash error', e)
    return "NO_SUCCESS"
  }
}

/**
 * Create middleware for handling certain methods and preprocessing permissions requests.
 */
export default function createPermissionsMethodMiddleware({
  addDomainMetadata,
  getAccounts,
  getUnlockPromise,
  hasPermission,
  notifyAccountsChanged,
  requestAccountsPermission,
}) {
  let isProcessingRequestAccounts = false;

  return createAsyncMiddleware(async (req, res, next) => {
    let responseHandler;

    switch (req.method) {
      // Intercepting eth_accounts requests for backwards compatibility:
      // The getAccounts call below wraps the rpc-cap middleware, and returns
      // an empty array in case of errors (such as 4100:unauthorized)
      case 'eth_accounts': {
        res.result = await getAccounts();
        return;
      }

      case 'eth_sysInfo': {
        res.result = await getSysInfoHash();
        return;
      }

      case 'eth_requestAccounts': {
        if (isProcessingRequestAccounts) {
          res.error = ethErrors.rpc.resourceUnavailable(
            'Already processing eth_requestAccounts. Please wait.',
          );
          return;
        }

        if (hasPermission('eth_accounts')) {
          isProcessingRequestAccounts = true;
          await getUnlockPromise();
          isProcessingRequestAccounts = false;
        }

        // first, just try to get accounts
        let accounts = await getAccounts();
        if (accounts.length > 0) {
          res.result = accounts;
          return;
        }

        // if no accounts, request the accounts permission
        try {
          await requestAccountsPermission();
        } catch (err) {
          res.error = err;
          return;
        }

        // get the accounts again
        accounts = await getAccounts();
        /* istanbul ignore else: too hard to induce, see below comment */
        if (accounts.length > 0) {
          res.result = accounts;
        } else {
          // this should never happen, because it should be caught in the
          // above catch clause
          res.error = ethErrors.rpc.internal(
            'Accounts unexpectedly unavailable. Please report this bug.',
          );
        }

        return;
      }

      // custom method for getting metadata from the requesting domain,
      // sent automatically by the inpage provider when it's initialized
      case 'metamask_sendDomainMetadata': {
        if (typeof req.params?.name === 'string') {
          addDomainMetadata(req.origin, req.params);
        }
        res.result = true;
        return;
      }

      // register return handler to send accountsChanged notification
      case 'wallet_requestPermissions': {
        if ('eth_accounts' in req.params?.[0]) {
          responseHandler = async () => {
            if (Array.isArray(res.result)) {
              for (const permission of res.result) {
                if (permission.parentCapability === 'eth_accounts') {
                  notifyAccountsChanged(await getAccounts());
                }
              }
            }
          };
        }
        break;
      }

      default:
        break;
    }

    // when this promise resolves, the response is on its way back
    // eslint-disable-next-line node/callback-return
    await next();

    if (responseHandler) {
      responseHandler();
    }
  });
}
