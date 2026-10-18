import { Counter, Histogram, Registry } from 'prom-client';

export type ContractOperation = 'request_loan' | 'repay_loan' | 'liquidate';
export type ContractOperationStatus = 'success' | 'error';

export const metricsRegistry = new Registry();

export const contractInvocationDuration = new Histogram({
  name: 'contract_invocation_duration_seconds',
  help: 'Duration of Soroban contract invocations in seconds',
  labelNames: ['operation', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const contractInvocationTotal = new Counter({
  name: 'contract_invocation_total',
  help: 'Total number of Soroban contract invocations',
  labelNames: ['operation', 'status'] as const,
  registers: [metricsRegistry],
});

export interface SorobanRpcClient {
  invokeContract(params: {
    operation: ContractOperation;
    contractId: string;
    method: string;
    args?: unknown[];
  }): Promise<unknown>;
}

export interface SorobanServiceOptions {
  rpcClient: SorobanRpcClient;
  contractId: string;
}

export class SorobanService {
  private readonly rpcClient: SorobanRpcClient;
  private readonly contractId: string;

  constructor(options: SorobanServiceOptions) {
    this.rpcClient = options.rpcClient;
    this.contractId = options.contractId;
  }

  private async invoke(
    operation: ContractOperation,
    method: string,
    args?: unknown[],
  ): Promise<unknown> {
    const endTimer = contractInvocationDuration.startTimer({ operation });
    try {
      const result = await this.rpcClient.invokeContract({
        operation,
        contractId: this.contractId,
        method,
        args,
      });
      endTimer({ status: 'success' });
      contractInvocationTotal.inc({ operation, status: 'success' });
      return result;
    } catch (error) {
      endTimer({ status: 'error' });
      contractInvocationTotal.inc({ operation, status: 'error' });
      throw error;
    }
  }

  requestLoan(args?: unknown[]): Promise<unknown> {
    return this.invoke('request_loan', 'request_loan', args);
  }

  repayLoan(args?: unknown[]): Promise<unknown> {
    return this.invoke('repay_loan', 'repay_loan', args);
  }

  liquidate(args?: unknown[]): Promise<unknown> {
    return this.invoke('liquidate', 'liquidate', args);
  }
}
