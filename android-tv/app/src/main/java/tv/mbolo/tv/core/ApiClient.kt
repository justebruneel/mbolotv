package tv.mbolo.tv.core

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import tv.mbolo.tv.BuildConfig
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

/**
 * Client HTTP natif : OkHttp direct vers l'API Mbolo.
 * - `x-device-id` persistant sur chaque requête (jamais régénéré).
 * - Requêtes ANNULABLES : quitter un écran annule le Call OkHttp sous-jacent
 *   (pas de thread bloqué 15s sur Wi-Fi lent, pas de callback sur vue morte).
 * - Backoff par `delay()` (annulable), jamais `Thread.sleep()`.
 * - GET catalogue : retry 3× sur réseau/5xx uniquement.
 * - Play URLs (`noRetry=true`) : 1 seul essai + `FORCE_NETWORK` — le serveur a
 *   déjà tout tenté ET une URL signée ne doit jamais venir du cache HTTP.
 * - 403 → ApiException(isAccessDenied) : l'UI revient à l'écran d'accès.
 */
class ApiClient(
    val baseUrl: String,
    cacheDir: File?,
    private val deviceId: () -> String,
) {
    /** Chemin historique (Activity) : base URL prod + cache disque 10 Mo. */
    constructor(context: Context, store: DeviceStore) : this(
        BuildConfig.MBOLO_API_URL.trimEnd('/'),
        File(context.applicationContext.cacheDir, "api-http"),
        store::deviceId,
    )

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(ApiConfig.CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(ApiConfig.READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .apply { if (cacheDir != null) cache(Cache(cacheDir, ApiConfig.HTTP_CACHE_BYTES)) }
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    /** Exécute un Call de façon annulable : cancel() propage `Call.cancel()`. */
    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { try {
            cancel()
        } catch (_: Exception) {
        } }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!cont.isCompleted) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                if (!cont.isCompleted) cont.resume(response) { _, _, _ -> response.close() }
            }
        })
    }

    suspend fun get(path: String, params: Map<String, String?> = emptyMap(), noRetry: Boolean = false): JSONObject =
        withContext(Dispatchers.IO) {
            val url = (baseUrl + path).toHttpUrl().newBuilder().apply {
                params.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
            }.build()
            val attempts = if (noRetry) 1 else 3
            var last: Exception? = null
            repeat(attempts) { i ->
                try {
                    val t0 = System.currentTimeMillis()
                    val req = Request.Builder()
                        .url(url)
                        .header("x-device-id", deviceId())
                        .header("accept", "application/json")
                        // URL signée : jamais de cache HTTP (expiry), toujours réseau.
                        .apply { if (noRetry) cacheControl(CacheControl.FORCE_NETWORK) }
                        .get().build()
                    client.newCall(req).await().use { resp ->
                        Telemetry.apiLatency(System.currentTimeMillis() - t0)
                        val body = resp.body?.string().orEmpty()
                        if (resp.isSuccessful) return@withContext wrap(body, path)
                        if (resp.code >= 500 && i + 1 < attempts) {
                            delay(250L * (1 shl i))
                            return@repeat
                        }
                        throw ApiException(resp.code, path, "API ${resp.code} sur $path")
                    }
                } catch (e: ApiException) {
                    throw e
                } catch (e: java.util.concurrent.CancellationException) {
                    throw e
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    last = e
                    if (i + 1 < attempts) delay(250L * (1 shl i))
                }
            }
            throw last ?: ApiException(-1, path, "Échec réseau sur $path")
        }

    suspend fun post(path: String, json: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl + path)
            .header("x-device-id", deviceId())
            .header("accept", "application/json")
            .post(json.toString().toRequestBody(jsonMedia))
            .build()
        client.newCall(req).await().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.isSuccessful) return@withContext wrap(body, path)
            throw ApiException(resp.code, path, "API ${resp.code} sur $path")
        }
    }

    suspend fun put(path: String): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl + path)
            .header("x-device-id", deviceId())
            .header("accept", "application/json")
            .put("{}".toRequestBody(jsonMedia))
            .build()
        client.newCall(req).await().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.isSuccessful) return@withContext wrap(body, path)
            throw ApiException(resp.code, path, "API ${resp.code} sur $path")
        }
    }

    suspend fun delete(path: String): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl + path)
            .header("x-device-id", deviceId())
            .header("accept", "application/json")
            .delete().build()
        client.newCall(req).await().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.isSuccessful) return@withContext wrap(body, path)
            throw ApiException(resp.code, path, "API ${resp.code} sur $path")
        }
    }

    companion object {
        /**
         * Certaines routes renvoient un tableau JSON nu ([...]) : on l'enveloppe
         * en {"items":[...]} pour un parsing uniforme côté repository.
         */
        fun wrap(body: String, path: String): JSONObject {
            val t = body.trim()
            if (t.isEmpty()) return JSONObject()
            return try {
                if (t.startsWith("[")) JSONObject().put("items", org.json.JSONArray(t))
                else JSONObject(t)
            } catch (_: Exception) {
                throw ApiException(-1, path, "Réponse illisible sur $path")
            }
        }
    }
}
