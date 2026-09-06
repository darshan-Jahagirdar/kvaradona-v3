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
