export interface Provider {
  involved: boolean;
  url: string;
  scraper: string;
  maxPages?: number;
  maxProducts?: number;
}

export interface ProvidersConfig {
  [key: string]: Provider;
}
