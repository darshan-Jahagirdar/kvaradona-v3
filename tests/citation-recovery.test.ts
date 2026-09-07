import {expect,it} from 'vitest';
import {sourceQuote} from '../src/domain/policy';
it('recovers quoted formatting and combined excerpts only from literal original text',()=>{
 const source='Hiring organization: Fixture. It uses HubSpot CRM for routing. Connect disparate data sources to reporting.';
 expect(sourceQuote('“Hiring organization: Fixture.”',source)).toBe('Hiring organization: Fixture.');
 expect(sourceQuote('“HubSpot CRM” and “Connect disparate data sources”.',source)).toBe('HubSpot CRM for routing. Connect disparate data sources');
 expect(sourceQuote('“HubSpot CRM” and “needs outside help”.',source)).toBeNull();
 expect(sourceQuote('“HubSpot CRM” urgently needs help',source)).toBeNull();
 expect(sourceQuote('They are buying a migration.',source)).toBeNull();
});
it('recovers an ellipsis-elided quote only from literal fragments in source order',()=>{
 const source='OCDC is a private, non-profit corporation established in 1971. It serves families across 15 counties in Oregon and Washington with more than 1,000 employees on staff.';
 expect(sourceQuote('“across 15 counties... with more than 1,000 employees”',source)).toBe('across 15 counties in Oregon and Washington with more than 1,000 employees');
 expect(sourceQuote('“across 15 counties…with more than 1,000 employees”',source)).toBe('across 15 counties in Oregon and Washington with more than 1,000 employees');
 expect(sourceQuote('“with more than 1,000 employees... across 15 counties”',source)).toBeNull();
 expect(sourceQuote('“across 15 counties... and a stated CRM migration”',source)).toBeNull();
 expect(sourceQuote('“across 15 counties...” urgently needs help',source)).toBeNull();
 expect(sourceQuote('“...”',source)).toBeNull();
 // The live B&S failure: provider metadata quoted against website evidence must never repair.
 expect(sourceQuote('Provider-reported topic: “media & advertising: pardot”',source)).toBeNull();
});
