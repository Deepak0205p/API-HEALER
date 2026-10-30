import { describe, test, expect } from 'bun:test';
import { executeAgentSwarm } from '@/lib/ai/agent-swarm';

describe('Loop-2 Multi-Agent Swarm Orchestrator (Master -> Sub-Orchestrator -> Patchers)', () => {
  test('Master Orchestrator dispatches 3 Sub-Orchestrators and 6 Specialized Patchers in parallel', async () => {
    const swarm = await executeAgentSwarm({
      errorType: 'ARRAY_METHOD_TRAP',
      statusCode: 200,
      rawPayload: { items: null, user: null },
      crashSignature: "TypeError: items.map is not a function",
      context: { url: '/api/v1/orders', method: 'GET' },
      forceFallback: true,
    });

    expect(swarm.masterOrchestrator.role).toBe('MASTER_ORCHESTRATOR');
    expect(swarm.masterOrchestrator.blastRadiusCount).toBe(5);
    expect(swarm.subOrchestrators.length).toBe(3);

    const totalPatchers = swarm.subOrchestrators.reduce(
      (acc, sub) => acc + sub.patchers.length,
      0,
    );
    expect(totalPatchers).toBe(6);
    expect(swarm.filesPatched.length).toBe(6);

    // Verify all 3 domains are represented
    const domains = swarm.subOrchestrators.map((s) => s.domain);
    expect(domains).toContain('CONTRACT_SCHEMA');
    expect(domains).toContain('TRANSPORT_AND_UI');
    expect(domains).toContain('CANARY_AND_SECURITY');

    // Verify combined unified diff contains all 6 files
    for (const file of swarm.filesPatched) {
      expect(swarm.combinedUnifiedDiff).toContain(`+++ b/${file.filePath}`);
    }

    // Verify 3-Gate security verdict
    expect(swarm.gateVerdict.gate1ContractSafety).toBe(true);
    expect(swarm.gateVerdict.gate2SigmaGuard).toBe(true);
    expect(swarm.gateVerdict.gate3ZeroRceVerified).toBe(true);
  });
});
