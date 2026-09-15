package tv.mbolo.tv.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * Type de réseau, borné (pas de listener, juste une mesure à la demande).
 * Retourne UNMETERED/METERED/OFFLINE — suffisant pour régler le prefetch
 * et éventuellement activer le mode data saver par défaut sur réseau celular.
 */
object NetworkInfo {
    enum class Kind { OFFLINE, UNMETERED, METERED, UNKNOWN }

    fun current(context: Context): Kind {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return Kind.OFFLINE
        val caps = cm.getNetworkCapabilities(net) ?: return Kind.OFFLINE
        return when {
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> Kind.OFFLINE
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> Kind.UNMETERED
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Kind.METERED
            else -> Kind.UNKNOWN
        }
    }
}