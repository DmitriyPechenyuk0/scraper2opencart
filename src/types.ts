export interface Provider {
  involved: boolean;
  url: string;
  scraper: string;
}

export interface ProvidersConfig {
  [key: string]: Provider;
}
