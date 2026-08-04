import fs from 'fs';
import path from 'path';
import { formatJson } from '../kulala-core';

export interface KulalaOAuth2PublicConfig {
  Type: 'OAuth2';
  'Grant Type': string;
  'Auth URL'?: string;
  'Token URL'?: string;
  'Redirect URL'?: string;
  'Client ID': string;
  'Client Credentials'?: string;
  PKCE?: boolean | { 'Code Challenge Method'?: string };
  Scope?: string;
  Username?: string;
}

export interface KulalaOAuth2PrivateConfig {
  'Client Secret'?: string;
  Password?: string;
}

export interface BrunoEnvironment {
  name: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  auth?: Record<string, KulalaOAuth2PublicConfig>;
  authPrivate?: Record<string, KulalaOAuth2PrivateConfig>;
}

const HTTP_CLIENT_ENV_SCHEMA = 'https://kulala.app/http-client.env.schema.json';
const HTTP_CLIENT_PRIVATE_ENV_SCHEMA = 'https://kulala.app/http-client.private.env.schema.json';

type HttpClientEnvSection = Record<string, unknown>;

type HttpClientEnvFile = {
  $schema?: string;
  [environmentName: string]: HttpClientEnvSection | string | undefined;
};

function buildPublicEnvironmentSection(environment: BrunoEnvironment): HttpClientEnvSection {
  const section: HttpClientEnvSection = { ...environment.vars };

  if (environment.auth && Object.keys(environment.auth).length > 0) {
    section.Security = { Auth: environment.auth };
  }

  return section;
}

function buildPrivateEnvironmentSection(environment: BrunoEnvironment): HttpClientEnvSection {
  const section: HttpClientEnvSection = { ...environment.secrets };

  if (environment.authPrivate && Object.keys(environment.authPrivate).length > 0) {
    section.Security = { Auth: environment.authPrivate };
  }

  return section;
}

function sectionHasContent(section: HttpClientEnvSection): boolean {
  return Object.keys(section).length > 0;
}

export function buildHttpClientEnvJson(environments: BrunoEnvironment[]): HttpClientEnvFile {
  const file: HttpClientEnvFile = {
    $schema: HTTP_CLIENT_ENV_SCHEMA,
  };

  for (const environment of environments) {
    const section = buildPublicEnvironmentSection(environment);
    if (sectionHasContent(section)) {
      file[environment.name] = section;
    }
  }

  return file;
}

export function buildHttpClientPrivateEnvJson(
  environments: BrunoEnvironment[],
): HttpClientEnvFile | null {
  const file: HttpClientEnvFile = {
    $schema: HTTP_CLIENT_PRIVATE_ENV_SCHEMA,
  };

  let hasSecrets = false;

  for (const environment of environments) {
    const section = buildPrivateEnvironmentSection(environment);
    if (sectionHasContent(section)) {
      file[environment.name] = section;
      hasSecrets = true;
    }
  }

  return hasSecrets ? file : null;
}

export async function writeHttpClientEnvFiles(
  environments: BrunoEnvironment[],
  outputDir: string = process.cwd(),
): Promise<{ wrotePublic: boolean; wrotePrivate: boolean }> {
  let wrotePublic = false;
  let wrotePrivate = false;

  const envFile = buildHttpClientEnvJson(environments);
  const hasPublicVars = Object.keys(envFile).some((key) => key !== '$schema');

  if (hasPublicVars) {
    const envPath = path.join(outputDir, 'http-client.env.json');
    fs.writeFileSync(envPath, (await formatJson(envFile)) + '\n', 'utf-8');
    wrotePublic = true;
  }

  const privateEnvFile = buildHttpClientPrivateEnvJson(environments);
  if (privateEnvFile) {
    const privateEnvPath = path.join(outputDir, 'http-client.private.env.json');
    fs.writeFileSync(privateEnvPath, (await formatJson(privateEnvFile)) + '\n', 'utf-8');
    wrotePrivate = true;
  }

  return { wrotePublic, wrotePrivate };
}
