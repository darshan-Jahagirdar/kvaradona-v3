import type { NextConfig } from 'next';
import { loadEnvironment } from './src/config/env';
loadEnvironment();
const config: NextConfig = { poweredByHeader: false, serverExternalPackages: ['@electric-sql/pglite'], devIndicators: false };
export default config;
