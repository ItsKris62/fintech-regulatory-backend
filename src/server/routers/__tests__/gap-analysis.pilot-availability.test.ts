import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  getPilotJurisdictionAvailability,
  getPilotFrameworkAvailability,
  getGapAnalysisPilotAvailability,
  getGapAnalysisContract,
} from '@/config/gap-analysis.config';

describe('Gap Analysis Pilot Availability Contract', () => {
  const origEnabledJurisdictions = process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS;
  const origValidatedJurisdictions = process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS;
  const origEnabledFrameworks = process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS;
  const origValidatedFrameworks = process.env.GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS;
  const origStrictGate = process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;

  beforeEach(() => {
    delete process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS;
    delete process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS;
    delete process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS;
    delete process.env.GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS;
    process.env.GAP_ANALYSIS_PILOT_STRICT_GATE = 'true';
  });

  afterEach(() => {
    if (origEnabledJurisdictions !== undefined) process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS = origEnabledJurisdictions;
    else delete process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS;

    if (origValidatedJurisdictions !== undefined) process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS = origValidatedJurisdictions;
    else delete process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS;

    if (origEnabledFrameworks !== undefined) process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS = origEnabledFrameworks;
    else delete process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS;

    if (origValidatedFrameworks !== undefined) process.env.GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS = origValidatedFrameworks;
    else delete process.env.GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS;

    if (origStrictGate !== undefined) process.env.GAP_ANALYSIS_PILOT_STRICT_GATE = origStrictGate;
    else delete process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;
  });

  it('1. unconfigured baseline does not automatically validate or enable Kenya', () => {
    const ke = getPilotJurisdictionAvailability('KE');
    expect(ke.jurisdiction).toBe('KE');
    expect(ke.pilotEnabled).toBe(false);
    expect(ke.readiness).toBe('INDEXED_PARTIAL');
    expect(ke.readiness).not.toBe('VALIDATED_FOR_GAP_ANALYSIS');
    expect(ke.message).toContain('pending formal release validation');
  });

  it('2. unconfigured secondary jurisdictions (RW, MW, NG) default to UNAVAILABLE', () => {
    for (const code of ['RW', 'MW', 'NG']) {
      const avail = getPilotJurisdictionAvailability(code);
      expect(avail.jurisdiction).toBe(code);
      expect(avail.pilotEnabled).toBe(false);
      expect(avail.readiness).toBe('UNAVAILABLE');
    }
  });

  it('3. release-configured enabled jurisdiction grants pilotEnabled with INDEXED_PARTIAL', () => {
    process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS = 'KE';
    const ke = getPilotJurisdictionAvailability('KE');
    expect(ke.pilotEnabled).toBe(true);
    expect(ke.readiness).toBe('INDEXED_PARTIAL');
    expect(ke.message).toContain('reviewed corpus and requirement-inventory attestations');
  });

  it('4. legacy validated flags enable UI access but cannot assert regulatory readiness', () => {
    process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS = 'KE';
    const ke = getPilotJurisdictionAvailability('KE');
    expect(ke.pilotEnabled).toBe(true);
    expect(ke.readiness).toBe('INDEXED_PARTIAL');
    expect(ke.message).toContain('reviewed corpus and requirement-inventory attestations');
  });

  it('5. framework catalog presence does not imply pilot readiness', () => {
    // Unconfigured frameworks are not pilot enabled
    const fw = getPilotFrameworkAvailability('cbk-cyber');
    expect(fw.pilotEnabled).toBe(false);
    expect(fw.readiness).toBe('UNAVAILABLE');
  });

  it('6. release-enabled framework becomes pilot enabled', () => {
    process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS = 'cbk-cyber,dpa-2019';
    const enabledFw = getPilotFrameworkAvailability('cbk-cyber');
    expect(enabledFw.pilotEnabled).toBe(true);
    expect(enabledFw.readiness).toBe('INDEXED_PARTIAL');

    const otherFw = getPilotFrameworkAvailability('nps-2011');
    expect(otherFw.pilotEnabled).toBe(false);
    expect(otherFw.readiness).toBe('UNAVAILABLE');
  });

  it('7. readiness state never claims COMPLETE (contract limits to approved enum)', () => {
    const avail = getGapAnalysisPilotAvailability();
    for (const j of Object.values(avail.jurisdictions)) {
      expect(['UNAVAILABLE', 'INDEXED_PARTIAL', 'VALIDATED_FOR_GAP_ANALYSIS', 'STALE_OR_UNKNOWN']).toContain(j.readiness);
      expect(j.readiness).not.toBe('COMPLETE');
    }
  });

  it('8. getGapAnalysisContract carries pilotAvailability payload', () => {
    const contract = getGapAnalysisContract('BUSINESS');
    expect(contract.pilotAvailability).toBeDefined();
    expect(contract.pilotAvailability.jurisdictions.KE).toBeDefined();
    expect(contract.pilotAvailability.jurisdictions.RW).toBeDefined();
  });

  it('9. release defaults do not grant UI access or claim regulatory validation', () => {
    delete process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;
    for (const code of ['KE', 'RW', 'MW', 'NG']) {
      const avail = getPilotJurisdictionAvailability(code);
      expect(avail.jurisdiction).toBe(code);
      expect(avail.pilotEnabled).toBe(false);
      expect(avail.readiness).toBe('UNAVAILABLE');
    }
  });

  it('10. formerly configured framework packs remain unavailable without explicit UI access', () => {
    delete process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;
    const validatedPacks = [
      { slug: 'dpa-2019', country: 'KE' },
      { slug: 'rw-dpa-2021', country: 'RW' },
      { slug: 'mw-cybersecurity-2016', country: 'MW' },
      { slug: 'ndpa-2023', country: 'NG' },
    ];

    for (const pack of validatedPacks) {
      const avail = getPilotFrameworkAvailability(pack.slug, pack.country);
      expect(avail.slug).toBe(pack.slug);
      expect(avail.pilotEnabled).toBe(false);
      expect(avail.readiness).toBe('INDEXED_PARTIAL');
    }
  });

  it('11. pending secondary frameworks remain INDEXED_PARTIAL and not selectable', () => {
    delete process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;
    const pendingFrameworks = [
      'odpc-regs-2021',
      'bnr-cybersecurity-2021',
      'mw-dpa-2024',
      'cbn-cybersecurity-2024',
    ];

    for (const slug of pendingFrameworks) {
      const avail = getPilotFrameworkAvailability(slug);
      expect(avail.slug).toBe(slug);
      expect(avail.pilotEnabled).toBe(false);
      expect(avail.readiness).toBe('INDEXED_PARTIAL');
    }
  });

  it('12. unknown frameworks remain fail-closed UNAVAILABLE', () => {
    delete process.env.GAP_ANALYSIS_PILOT_STRICT_GATE;
    const fake = getPilotFrameworkAvailability('unknown-foreign-regulation');
    expect(fake.pilotEnabled).toBe(false);
    expect(fake.readiness).toBe('UNAVAILABLE');
  });
});
