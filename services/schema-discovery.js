import { getMetadata } from './ampre-api.js';
import { logger } from '../utils/logger.js';

// Discover schema from the API metadata
export const discoverSchema = async () => {
  try {
    const metadata = await getMetadata();
    logger.info('Retrieved API metadata');

    // Analyze metadata to find the Property entity type
    const propertySchema = extractPropertySchema(metadata);
    
    if (!propertySchema) {
      throw new Error('Failed to extract Property schema from metadata');
    }
    
    logger.info(`Discovered ${propertySchema.properties.length} properties in the schema`);
    
    return propertySchema;
  } catch (error) {
    logger.error('Schema discovery failed:', error);
    throw error;
  }
};

// Extract Property entity type and its properties
const extractPropertySchema = (metadata) => {
  try {
    // The API might return different formats of metadata
    // Try various possible structures
    
    // Handle different formats of metadata
    let schemaElement = null;
    let entityTypes = null;
    
    // Approach 1: Standard OData v4 format
    if (metadata && metadata['edmx:Edmx'] && metadata['edmx:Edmx']['edmx:DataServices'] && metadata['edmx:Edmx']['edmx:DataServices'].Schema) {
      schemaElement = metadata['edmx:Edmx']['edmx:DataServices'].Schema;
      entityTypes = Array.isArray(schemaElement.EntityType) ? schemaElement.EntityType : [schemaElement.EntityType];
    } 
    // Approach 2: Simplified format some APIs use
    else if (metadata && metadata.EntitySets) {
      return createBasicSchema(metadata);
    }
    // Approach 3: If we get JSON directly describing a property
    else if (metadata && metadata.value && metadata.value.length > 0) {
      return createSchemaFromSample(metadata.value[0]);
    }
    
    if (!schemaElement || !entityTypes) {
      logger.warn('Metadata format not recognized, using default schema');
      return createDefaultSchema();
    }
    
    // Find the Property EntityType
    const propertyEntityType = entityTypes.find(
      entity => entity && entity.Name === 'Property'
    );
    
    if (!propertyEntityType) {
      logger.warn('Property EntityType not found in metadata, using default schema');
      return createDefaultSchema();
    }
    
    // Extract properties - handle both array and single object cases
    const propArray = Array.isArray(propertyEntityType.Property) 
      ? propertyEntityType.Property 
      : [propertyEntityType.Property];
      
    const properties = propArray.map(prop => ({
      name: prop.Name,
      type: prop.Type,
      nullable: prop.Nullable === 'true',
      maxLength: prop.MaxLength ? parseInt(prop.MaxLength, 10) : null
    }));
    
    // Extract navigation properties (like Media)
    const navProps = propertyEntityType.NavigationProperty;
    const navigationProperties = navProps
      ? (Array.isArray(navProps) 
          ? navProps 
          : [navProps]).map(navProp => ({
            name: navProp.Name,
            type: navProp.Type,
            relationship: navProp.Relationship
          }))
      : [];
    
    return {
      entityName: 'Property',
      properties,
      navigationProperties
    };
  } catch (error) {
    logger.error('Failed to extract Property schema:', error);
    // Return a default schema so we can continue
    return createDefaultSchema();
  }
};

// Create a basic schema from an EntitySets format
const createBasicSchema = (metadata) => {
  try {
    const properties = [];
    
    // Extract known property fields from EntitySets
    const propertySet = metadata.EntitySets.find(set => set.name === 'Property');
    
    if (propertySet && propertySet.entityType && propertySet.entityType.properties) {
      for (const prop of propertySet.entityType.properties) {
        properties.push({
          name: prop.name,
          type: prop.type,
          nullable: prop.nullable !== false
        });
      }
    }
    
    return {
      entityName: 'Property',
      properties: properties.length > 0 ? properties : getDefaultProperties(),
      navigationProperties: [{ name: 'Media', type: 'Collection(Media)' }]
    };
  } catch (error) {
    logger.error('Failed to create basic schema:', error);
    return createDefaultSchema();
  }
};

// Create a schema by analyzing a sample property
const createSchemaFromSample = (sample) => {
  try {
    const properties = [];
    
    // Extract property field names and guess types from the sample data
    for (const [key, value] of Object.entries(sample)) {
      let type = 'Edm.String';
      
      if (typeof value === 'number') {
        type = Number.isInteger(value) ? 'Edm.Int32' : 'Edm.Decimal';
      } else if (typeof value === 'boolean') {
        type = 'Edm.Boolean';
      } else if (value instanceof Date) {
        type = 'Edm.DateTimeOffset';
      } else if (Array.isArray(value)) {
        type = 'Collection(Edm.String)';
      }
      
      properties.push({
        name: key,
        type,
        nullable: true
      });
    }
    
    return {
      entityName: 'Property',
      properties,
      navigationProperties: [{ name: 'Media', type: 'Collection(Media)' }]
    };
  } catch (error) {
    logger.error('Failed to create schema from sample:', error);
    return createDefaultSchema();
  }
};

// Create a default schema with common property fields
const createDefaultSchema = () => {
  return {
    entityName: 'Property',
    properties: getDefaultProperties(),
    navigationProperties: [{ name: 'Media', type: 'Collection(Media)' }]
  };
};

// Get a list of default property fields we expect to find
const getDefaultProperties = () => {
  return [
    { name: 'ListingKey', type: 'Edm.String', nullable: false },
    { name: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', nullable: false },
    { name: 'MediaChangeTimestamp', type: 'Edm.DateTimeOffset', nullable: true },
    { name: 'PropertyType', type: 'Edm.String', nullable: true },
    { name: 'PropertySubType', type: 'Edm.String', nullable: true },
    { name: 'ListPrice', type: 'Edm.Decimal', nullable: true },
    { name: 'BedroomsTotal', type: 'Edm.Int32', nullable: true },
    { name: 'BathroomsTotalInteger', type: 'Edm.Int32', nullable: true },
    { name: 'City', type: 'Edm.String', nullable: true },
    { name: 'StateOrProvince', type: 'Edm.String', nullable: true },
    { name: 'PostalCode', type: 'Edm.String', nullable: true },
    { name: 'UnparsedAddress', type: 'Edm.String', nullable: true },
    { name: 'Latitude', type: 'Edm.Decimal', nullable: true },
    { name: 'Longitude', type: 'Edm.Decimal', nullable: true },
    { name: 'PublicRemarks', type: 'Edm.String', nullable: true },
    { name: 'StandardStatus', type: 'Edm.String', nullable: true }
  ];
};

// Generate SQL for altering the database schema based on discovered properties
export const generateSchemaUpdateSQL = (schema) => {
  try {
    if (!schema || !schema.properties || schema.properties.length === 0) {
      logger.warn('No schema properties found, skipping schema update SQL generation');
      return null;
    }
    
    // Start with base columns that we know we need
    const knownColumns = [
      'id', 'unparsed_address', 'city', 'province', 'postal_code',
      'property_type', 'property_sub_type', 'list_price', 'bedrooms_total',
      'bathrooms_total', 'latitude', 'longitude', 'media_keys', 
      'modification_timestamp', 'raw'
    ];
    
    // Map EDMX data types to PostgreSQL data types
    const typeMapping = {
      'Edm.String': 'TEXT',
      'Edm.Int32': 'INTEGER',
      'Edm.Int64': 'BIGINT',
      'Edm.Decimal': 'DECIMAL',
      'Edm.Double': 'DOUBLE PRECISION',
      'Edm.Boolean': 'BOOLEAN',
      'Edm.DateTimeOffset': 'TIMESTAMP WITH TIME ZONE',
      'Edm.Date': 'DATE',
      'Edm.Time': 'TIME',
      'Edm.Geography': 'GEOGRAPHY',
      'Collection(Edm.String)': 'TEXT[]'
    };
    
    // Generate SQL statements for columns that aren't in our base schema
    const alterTableStatements = [];
    
    for (const prop of schema.properties) {
      // Skip properties that we don't know how to handle or that don't have a name
      if (!prop || !prop.name) {
        continue;
      }
      
      // Convert property name to snake_case for postgres
      const columnName = prop.name
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '');
      
      // Skip properties that are already in our base schema or that we don't want to add
      // (they're covered by the 'raw' JSONB column)
      if (knownColumns.includes(columnName)) {
        continue;
      }
      
      // Map the type, default to TEXT if we don't know the type
      const sqlType = typeMapping[prop.type] || 'TEXT';
      
      // Add alter table statement
      alterTableStatements.push(
        `ALTER TABLE listings ADD COLUMN IF NOT EXISTS ${columnName} ${sqlType} NULL;`
      );
    }
    
    // If navigation properties include Media, make sure we have media_keys column
    if (schema.navigationProperties && 
        schema.navigationProperties.some(nav => nav.name === 'Media') && 
        !knownColumns.includes('media_keys')) {
      alterTableStatements.push(
        `ALTER TABLE listings ADD COLUMN IF NOT EXISTS media_keys TEXT[] NULL;`
      );
    }
    
    if (alterTableStatements.length === 0) {
      return null; // No changes needed
    }
    
    return alterTableStatements.join('\n');
  } catch (error) {
    logger.error('Failed to generate schema update SQL:', error);
    return null; // Return null instead of throwing to allow the app to continue
  }
}; 