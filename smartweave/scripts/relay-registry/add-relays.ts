import { LoggerFactory, WarpFactory } from 'warp-contracts'
import { EthereumSigner } from 'warp-contracts-plugin-deploy'
import { EthersExtension } from 'warp-contracts-plugin-ethers'
import {
  buildEvmSignature,
  EvmSignatureVerificationServerPlugin
  // @ts-ignore
} from 'warp-contracts-plugin-signature/server'
import { Wallet } from 'ethers'
import Consul from 'consul'
import BigNumber from 'bignumber.js'

import {
  AddClaimable,
  RelayRegistryHandle,
  RelayRegistryState
} from '../../src/contracts'

let contractTxId = ''
const consulToken = process.env.CONSUL_TOKEN
const contractOwnerPrivateKey = process.env.RELAY_REGISTRY_OWNER_KEY

LoggerFactory.INST.logLevel('error')
BigNumber.config({ EXPONENTIAL_AT: 50 })

const warp = WarpFactory
  .forMainnet()
  .use(new EthersExtension())
  .use(new EvmSignatureVerificationServerPlugin())

async function main() {
  let consul
  if (consulToken) {
    const host = process.env.CONSUL_IP,
      port = process.env.CONSUL_PORT,
      key = process.env.RELAY_REGISTRY_ADDRESS_CONSUL_KEY
    if (!host) { throw new Error('CONSUL_IP is not set!') }
    if (!port) { throw new Error('CONSUL_PORT is not set!') }
    if (!key) { throw new Error('RELAY_REGISTRY_ADDRESS_CONSUL_KEY is not set!') }
    
    console.log(`Connecting to Consul at ${host}:${port}`)
    consul = new Consul({ host, port })
    const { Value } = await consul.kv.get<{Value: string}>({ token: consulToken, key })
    contractTxId = Value
  }

  if (!contractTxId) {
    throw new Error('DISTRIBUTION_CONTRACT_ID is not set!')
  }

  if (!contractOwnerPrivateKey) {
    throw new Error('DISTRIBUTION_OWNER_KEY is not set!')
  }

  const contract = warp.contract<RelayRegistryState>(contractTxId)
  const contractOwner = new Wallet(contractOwnerPrivateKey)
  
  let claims: {address: string, fingerprint: string}[] = []

  if (consul) {
    const accountsData = await consul.kv.get<{ Value: string }>({
      key: process.env.TEST_ACCOUNTS_KEY || 'dummy-path',
      token: consulToken
    })
    

    if (accountsData) {
      const decodedValue = Buffer.from(accountsData.Value, 'base64').toString('utf-8');
      const accounts = JSON.parse(decodedValue) as string[];
      claims = accounts.map((acct, index, array) => ({
        address: acct,
        fingerprint: BigNumber(1E39).plus(index).integerValue().toString()
      }))

      console.log(claims)
    }
  }
  
  const timestamp = Date.now().toString()

  try {
    for (let i = 0; i < claims.length; i += 1) {
      const input: AddClaimable = {
        function: 'addClaimable',
        fingerprint: claims[i].fingerprint,
        address: claims[i].address,
      }
    
      // NB: Sanity check by getting current state and "dry-running" thru contract
      //     source handle directly.  If it doesn't throw, we're good.
      const { cachedValue: { state } } = await contract.readState()
      RelayRegistryHandle(state, {
        input,
        caller: contractOwner.address,
        interactionType: 'write'
      })
    
      // NB: Send off the interaction for real
      await contract
        .connect({
          signer: buildEvmSignature(contractOwner),
          type: 'ethereum'
        })
        .writeInteraction<AddClaimable>(input)
    }
  } catch(e) {
    console.error(e)
    console.log("Continuing execution")
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; })
