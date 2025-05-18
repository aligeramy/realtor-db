import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from './logger.js';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Standardize an address format using property fields
 */
export function standardizeAddress(property) {
  try {
    // Extract fields
    const {
      street_number,
      street_name,
      street_suffix,
      unit_number,
      city,
      province,
      postal_code
    } = property;
    
    // Build standardized address components
    const streetComponent = [
      street_number,
      street_name,
      street_suffix
    ].filter(Boolean).join(' ');
    
    const unitComponent = unit_number ? `Unit ${unit_number}` : '';
    
    const cityComponent = city || '';
    const provinceComponent = province || '';
    const postalComponent = postal_code ? postal_code.toUpperCase().replace(/\s+/g, '') : '';
    
    // Combine components to create standardized address
    const addressParts = [
      unitComponent,
      streetComponent,
      cityComponent,
      provinceComponent,
      postalComponent
    ].filter(Boolean);
    
    return addressParts.join(', ');
  } catch (error) {
    logger.error('Address standardization error:', error);
    return property.unparsed_address || '';
  }
}

/**
 * Geocode an address using Google Maps API
 */
export async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    logger.warn('No Google Maps API key provided. Geocoding disabled.');
    return { lat: null, lng: null };
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address,
        key: GOOGLE_MAPS_API_KEY
      }
    });
    
    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const { lat, lng } = response.data.results[0].geometry.location;
      return { lat, lng };
    }
    
    logger.warn(`Geocoding failed for address: ${address}. Status: ${response.data.status}`);
    return { lat: null, lng: null };
  } catch (error) {
    logger.error('Geocoding error:', error);
    return { lat: null, lng: null };
  }
}

/**
 * Simple caching mechanism for geocoding results
 */
const geocodeCache = new Map();

/**
 * Geocode with caching to reduce API calls
 */
export async function geocodeWithCache(address) {
  // Check if result is already in cache
  if (geocodeCache.has(address)) {
    return geocodeCache.get(address);
  }
  
  // Call the geocoding API
  const result = await geocodeAddress(address);
  
  // Store in cache if coordinates were found
  if (result.lat && result.lng) {
    geocodeCache.set(address, result);
    
    // Prevent unbounded cache growth
    if (geocodeCache.size > 10000) {
      // Clear 20% of oldest entries
      const keys = Array.from(geocodeCache.keys()).slice(0, 2000);
      keys.forEach(key => geocodeCache.delete(key));
    }
  }
  
  return result;
} 