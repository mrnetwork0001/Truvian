/* Truvian Shield - browser wallet + x402 payment.

   Shield charges for a safety check once the free daily allowance is used.
   This module talks to an injected EIP-1193 wallet (MetaMask, Coinbase Wallet,
   Rabby, Brave) and turns a 402 challenge into a signed payment header:

     1. connect            eth_requestAccounts
     2. right network      wallet_switchEthereumChain (adds it if unknown)
     3. sign the challenge eth_signTypedData_v4 over EIP-3009
                           TransferWithAuthorization
     4. retry the request  X-PAYMENT: base64(payload)

   The signature authorizes a USDC transfer that the x402 facilitator submits,
   so paying costs the visitor no gas and Shield never sees a private key. No
   libraries, no bundler - plain ES5-compatible browser JavaScript. */
(function (global) {
  'use strict';

  var NETWORKS = {
    'base-sepolia': {
      chainIdHex: '0x14a34',
      chainId: 84532,
      chainName: 'Base Sepolia',
      rpcUrls: ['https://sepolia.base.org'],
      blockExplorerUrls: ['https://sepolia.basescan.org'],
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    },
    base: {
      chainIdHex: '0x2105',
      chainId: 8453,
      chainName: 'Base',
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    },
  };

  var state = { address: null };

  function provider() {
    return global.ethereum || null;
  }

  function isAvailable() {
    return !!provider();
  }

  function getAddress() {
    return state.address;
  }

  function request(method, params) {
    var p = provider();
    if (!p) return Promise.reject(new Error('No wallet found. Install MetaMask, Coinbase Wallet or Rabby.'));
    return p.request({ method: method, params: params || [] });
  }

  /** Prompt for accounts; resolves with the selected address. */
  function connect() {
    return request('eth_requestAccounts').then(function (accounts) {
      if (!accounts || !accounts.length) throw new Error('No account was shared by the wallet.');
      state.address = accounts[0];
      return state.address;
    });
  }

  /** Accounts already granted, without prompting (null when none). */
  function restore() {
    if (!isAvailable()) return Promise.resolve(null);
    return request('eth_accounts')
      .then(function (accounts) {
        state.address = accounts && accounts.length ? accounts[0] : null;
        return state.address;
      })
      .catch(function () {
        return null;
      });
  }

  /** Switch the wallet to `networkName`, adding the chain if it is unknown. */
  function ensureNetwork(networkName) {
    var net = NETWORKS[networkName];
    if (!net) return Promise.reject(new Error('Unsupported payment network: ' + networkName));
    return request('wallet_switchEthereumChain', [{ chainId: net.chainIdHex }]).catch(function (err) {
      // 4902 = chain not added to this wallet yet.
      var code = err && (err.code || (err.data && err.data.originalError && err.data.originalError.code));
      if (code !== 4902) throw err;
      return request('wallet_addEthereumChain', [
        {
          chainId: net.chainIdHex,
          chainName: net.chainName,
          rpcUrls: net.rpcUrls,
          blockExplorerUrls: net.blockExplorerUrls,
          nativeCurrency: net.nativeCurrency,
        },
      ]);
    });
  }

  function randomNonce() {
    var bytes = new Uint8Array(32);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    var hex = '0x';
    for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
    return hex;
  }

  function base64(text) {
    // btoa is byte-oriented; the payload is ASCII JSON so this is safe.
    return global.btoa(text);
  }

  /**
   * Sign one x402 payment for `requirements` (an entry from the 402 body's
   * `accepts`) and return the value for the X-PAYMENT header.
   */
  function signPayment(requirements) {
    var net = NETWORKS[requirements.network];
    if (!net) return Promise.reject(new Error('Unsupported payment network: ' + requirements.network));

    return Promise.resolve(state.address ? state.address : connect())
      .then(function () {
        return ensureNetwork(requirements.network);
      })
      .then(function () {
        var now = Math.floor(Date.now() / 1000);
        var timeout = requirements.maxTimeoutSeconds ? Number(requirements.maxTimeoutSeconds) : 300;
        var authorization = {
          from: state.address,
          to: requirements.payTo,
          value: String(requirements.maxAmountRequired),
          validAfter: String(now - 60),
          validBefore: String(now + Math.max(60, timeout)),
          nonce: randomNonce(),
        };
        var extra = requirements.extra || {};
        var typedData = {
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            TransferWithAuthorization: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          domain: {
            name: extra.name || 'USDC',
            version: extra.version || '2',
            chainId: net.chainId,
            verifyingContract: requirements.asset,
          },
          message: authorization,
        };
        return request('eth_signTypedData_v4', [state.address, JSON.stringify(typedData)]).then(function (signature) {
          return base64(
            JSON.stringify({
              x402Version: 1,
              scheme: 'exact',
              network: requirements.network,
              payload: { signature: signature, authorization: authorization },
            }),
          );
        });
      });
  }

  /** Short display form, e.g. 0xCd0a…3c02. */
  function shorten(address) {
    if (!address || address.length < 10) return address || '';
    return address.slice(0, 6) + '…' + address.slice(-4);
  }

  /** Notify the page when the wallet switches accounts or disconnects. */
  function onAccountsChanged(handler) {
    var p = provider();
    if (!p || typeof p.on !== 'function') return;
    p.on('accountsChanged', function (accounts) {
      state.address = accounts && accounts.length ? accounts[0] : null;
      handler(state.address);
    });
  }

  global.TruvianWallet = {
    isAvailable: isAvailable,
    connect: connect,
    restore: restore,
    getAddress: getAddress,
    ensureNetwork: ensureNetwork,
    signPayment: signPayment,
    shorten: shorten,
    onAccountsChanged: onAccountsChanged,
  };
})(window);
