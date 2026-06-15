
param location string = resourceGroup().location
param environmentName string
@secure()
param spotifyClientId string
@secure()
param spotifyClientSecret string
@secure()
param sessionSecret string

// Generiert einen garantiert kleingeschriebenen, eindeutigen Namen ohne Punkte
var uniqueSuffix = uniqueString(resourceGroup().id, environmentName)
var cleanCosmosName = toLower(replace('cosmos-${environmentName}-${uniqueSuffix}', '.', ''))

// 1. Cosmos DB
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = {
  name: cleanCosmosName // Verwendet jetzt den gesäuberten Namen ohne Punkte
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    capabilities: [{ name: 'EnableServerless' }]
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2023-04-15' = {
  parent: cosmosAccount
  name: 'SpotifyStats'
  properties: { resource: { id: 'SpotifyStats' } }
}

resource historyContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-04-15' = {
  parent: database
  name: 'HistoricalStats'
  properties: {
    resource: {
      id: 'HistoricalStats'
      partitionKey: { paths: [ '/partitionKey' ], kind: 'Hash' }
    }
  }
}

// 2. App Service Plan (Bleibt auf B1 stehen)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: 'asp-${environmentName}'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: { reserved: true }
}

// 3. App Service (Die eigentliche Web App)
resource appService 'Microsoft.Web/sites@2023-01-01' = {
  name: 'app-${environmentName}'
  location: location
  tags: { 'azd-service-name': 'app' } 
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appSettings: [
        // Auch hier nutzen wir die Variable, damit die Web-App die richtige DB findet
        { name: 'COSMOS_ENDPOINT', value: cosmosAccount.properties.documentEndpoint }
        { name: 'COSMOS_KEY', value: cosmosAccount.listKeys().primaryMasterKey }
        { name: 'SPOTIFY_CLIENT_ID', value: spotifyClientId }
        { name: 'SPOTIFY_CLIENT_SECRET', value: spotifyClientSecret }
        { name: 'SESSION_SECRET', value: sessionSecret }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
}
