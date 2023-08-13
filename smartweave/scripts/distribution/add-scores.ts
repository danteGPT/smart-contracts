import fs from 'fs'
import path from 'path'
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

import {
  DistributionHandle,
  DistributionState,
  AddScores,
  Score,
  Distribute
} from '../../src/contracts'

let contractTxId = process.env.DISTRIBUTION_CONTRACT_ID
const consulToken = process.env.CONSUL_TOKEN
const contractOwnerPrivateKey = process.env.DISTRIBUTION_OWNER_KEY
const pathToScores = process.env.SCORES_PATH

LoggerFactory.INST.logLevel('error')

const warp = WarpFactory
  .forMainnet()
  .use(new EthersExtension())
  .use(new EvmSignatureVerificationServerPlugin())

async function main() {
  let consul
  if (consulToken) {
    const host = process.env.CONSUL_IP,
      port = process.env.CONSUL_PORT,
      key = process.env.DISTRIBUTION_ADDRESS_CONSUL_KEY
    if (!host) { throw new Error('CONSUL_IP is not set!') }
    if (!port) { throw new Error('CONSUL_PORT is not set!') }
    if (!key) { throw new Error('DISTRIBUTION_ADDRESS_CONSUL_KEY is not set!') }
    
    console.log(`Connecting to Consul at ${host}:${port}`)
    consul = new Consul({ host, port })

    contractTxId = await consul.kv.get({ token: consulToken, key })
  }

  if (!contractTxId) {
    throw new Error('DISTRIBUTION_CONTRACT_ID is not set!')
  }

  if (!contractOwnerPrivateKey) {
    throw new Error('DISTRIBUTION_OWNER_KEY is not set!')
  }

  const contract = warp.contract<DistributionState>(contractTxId)
  const contractOwner = new EthereumSigner(contractOwnerPrivateKey)
  const contractOwnerAddress = new Wallet(contractOwnerPrivateKey).address
  let scores: Score[] = []
  
  if (pathToScores) {
    scores = JSON.parse(
      fs.readFileSync(path.join(__dirname, pathToScores)).toString()
    )
  } else {
    if (consul) {
      const accountsData: string = await consul.kv.get({
        key: process.env.TEST_ACCOUNTS_KEY || 'dummy-path',
        token: consulToken
      })
      if (accountsData) {
        const decodedValue = Buffer.from(accountsData, 'base64').toString('utf-8');
        const accounts = JSON.parse(decodedValue) as string[];
        scores = accounts.map((acct, index, array) => ({
          score: (10_000 + Math.random() * 10_000).toFixed(0),
          address: acct,
          fingerprint: (Math.random() * 1E32).toFixed(0)
        }))
      }
    }
  }
  const timestamp = Date.now().toString()

  const BATCH_SIZE = 5
  for (let i = 0; i < scores.length; i++) {
    const scoresBatch = scores.slice(i, i + BATCH_SIZE)
    const input: AddScores = {
      function: 'addScores',
      timestamp,
      scores: scoresBatch
    }
  
    // NB: Sanity check by getting current state and "dry-running" thru contract
    //     source handle directly.  If it doesn't throw, we're good.
    const { cachedValue: { state } } = await contract.readState()
    DistributionHandle(state, {
      input,
      caller: contractOwnerAddress,
      interactionType: 'write'
    })
  
    // NB: Send off the interaction for real
    await contract
      .connect({
        signer: buildEvmSignature(contractOwner),
        type: 'ethereum'
      })
      .writeInteraction<AddScores>(input)
  }

  const input: Distribute = { function: 'distribute', timestamp }

  // NB: Sanity check by getting current state and "dry-running" thru contract
  //     source handle directly.  If it doesn't throw, we're good.
  const { cachedValue: { state } } = await contract.readState()
  DistributionHandle(state, {
    input,
    caller: contractOwnerAddress,
    interactionType: 'write'
  })

  // NB: Send off the interaction for real
  await contract
    .connect({
      signer: buildEvmSignature(contractOwner),
      type: 'ethereum'
    })
    .writeInteraction<Distribute>(input)
}

main().catch(error => { console.error(error); process.exitCode = 1; })
