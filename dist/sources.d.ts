/**
 * Source registry — loads the curated Source Catalog (data/sources.json, 155 sources)
 * and appends Google News RSS meta-feed entries for topic-query coverage.
 *
 * Tech-only scope: AI/ML, developer tools, cloud-native, security.
 * See ARCHITECTURE.md §10 for tier taxonomy and product rules.
 */
import type { SourceDefinition, TopicDefinition, FetchStrategy } from './source-types.ts';
import type { TopicMeta } from '@ardurai/contracts';
export type { FetchStrategy, SourceDefinition, TopicDefinition };
export declare function loadSources(): SourceDefinition[];
export declare function loadTopics(): TopicDefinition[];
export declare function sourcesForTopic(topicId: string): SourceDefinition[];
export type { TopicMeta };
